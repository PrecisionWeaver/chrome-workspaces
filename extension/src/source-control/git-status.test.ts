// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BranchPr } from '../../../shared/protocol/protocol';
import { isolateDocumentListeners } from '../../testing/fixtures';
import { GIT_NOW, GIT_WORKSPACE, type GitViewHarness, gitState, mountGitView } from '../../testing/git-fixtures';

isolateDocumentListeners();

let h: GitViewHarness;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (selector: string, root: ParentNode = document) => [...root.querySelectorAll(selector)].map((node) => node.textContent);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(GIT_NOW);
  h = mountGitView();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the branch line', () => {
  it('shows the branch, with a button to switch', async () => {
    await h.ready(gitState({ branch: 'feature/x' }));
    expect(text('.git-branch-name span:nth-child(2)')).toEqual(['feature/x']);
    // A long name is cut with an ellipsis, so the tooltip carries all of it.
    expect($('git-branch').querySelector<HTMLElement>('.git-branch-name')!.title).toBe('feature/x\nSwitch branch');
  });

  it('says detached HEAD when there is no branch', async () => {
    await h.ready(gitState({ branch: null }));
    expect(text('.git-branch-name span:nth-child(2)')).toEqual(['detached HEAD']);
  });

  it('shows nothing before the first answer', () => {
    h.view.renderStatus();
    expect($('git-branch').children).toHaveLength(0);
  });

  it('shows commits ahead and behind, only when there are some', async () => {
    await h.ready(gitState({ ahead: 2, behind: 3 }));
    expect(text('.git-sync')).toEqual(['↑2', '↓3']);
    h.setState(gitState());
    expect(text('.git-sync')).toEqual([]);
  });

  it('offers to push when the branch is ahead or has no upstream, and not otherwise', async () => {
    await h.ready(gitState({ ahead: 2 }));
    const push = () => $('git-branch').querySelector<HTMLButtonElement>('.git-push');
    expect(push()!.textContent).toBe('Push');
    expect(push()!.title).toBe('Push main to origin');
    push()!.click();
    expect(h.sentOfType('gitPush')).toEqual([{ type: 'gitPush', id: 'ws-a' }]);
    expect(push()!.disabled).toBe(true);
    // A second click while the push is under way sends nothing more.
    push()!.click();
    expect(h.sentOfType('gitPush')).toHaveLength(1);
    h.view.setResult({ type: 'gitResult', id: 'ws-a', action: 'push', ok: false, message: 'no remote' });
    expect(push()!.disabled).toBe(false);
    h.setState(gitState({ upstream: null }));
    expect(push()).not.toBeNull();
    h.setState(gitState());
    expect(push()).toBeNull();
  });

  it('offers to compare with main', async () => {
    await h.ready(gitState({ branch: 'feature/x' }));
    const compare = $('git-branch').querySelector<HTMLButtonElement>('.git-chip-btn:not(.ci)')!;
    expect(compare.textContent).toBe('vs main');
    compare.click();
    expect(h.sentOfType('gitCompare')).toEqual([{ type: 'gitCompare', id: 'ws-a' }]);
  });

  it('says when Claude is in a linked worktree', async () => {
    await h.ready(gitState({ worktree: 'feature-a' }));
    expect(text('.git-worktree')).toEqual(['worktree · feature-a']);
    expect($('git-branch').querySelector<HTMLElement>('.git-worktree')!.title).toContain('/Users/me/acme');
  });

  it('says what Claude is doing, redrawn on request', async () => {
    await h.ready();
    expect(text('.git-claude')).toEqual([]);
    h.statuses['ws-a'] = 'needs_input';
    h.view.renderStatus();
    expect(text('.git-claude')).toEqual(['Claude needs input']);
    expect($('git-branch').querySelector<HTMLElement>('.git-claude')!.dataset.status).toBe('needs_input');
    h.waiting['ws-a'] = { type: 'permission_prompt', message: 'Claude needs your permission to use Bash' };
    h.view.renderStatus();
    expect(text('.git-claude')).toEqual(['Claude needs permission']);
    expect($('git-branch').querySelector<HTMLElement>('.git-claude')!.title).toBe('Claude needs your permission to use Bash');
    delete h.waiting['ws-a'];
    h.statuses['ws-a'] = 'working';
    h.view.renderStatus();
    expect(text('.git-claude')).toEqual(['Claude is working']);
    h.statuses['ws-a'] = 'idle';
    h.view.renderStatus();
    expect(text('.git-claude')).toEqual(['Claude is idle']);
  });

  it('says what Claude is doing even before git has answered', async () => {
    h.statuses['ws-a'] = 'working';
    h.view.setWorkspace(GIT_WORKSPACE);
    expect(text('.git-claude')).toEqual(['Claude is working']);
    expect($('git-branch').querySelector('.git-branch-name')).toBeNull();
  });

  describe('the pull request chip', () => {
    const pr: BranchPr = {
      number: 12,
      title: 'Add the thing',
      url: 'https://github.com/acme/app/pull/12',
      isDraft: false,
      reviewDecision: null,
      state: 'OPEN',
    };
    const checks = (passed: number, failed: number, pending: number, failing: string[] = []) => ({ passed, failed, pending, failing });
    const chip = () => $('git-branch').querySelector<HTMLButtonElement>('.ci');
    const answer = (prValue: typeof pr | null, checksValue: ReturnType<typeof checks> | null) =>
      h.view.setChecks({ type: 'gitChecks', id: 'ws-a', pr: prValue, checks: checksValue, error: null });

    it.each([
      [checks(5, 0, 0), '#12 · ✓ 5 passing', 'good'],
      [checks(3, 0, 2), '#12 · ● 2 running', 'wait'],
      [checks(3, 1, 2, ['lint']), '#12 · ✗ 1 failing', 'bad'],
      [checks(0, 0, 0), '#12 · no checks', ''],
      [null, '#12 · no checks', ''],
    ])('summarises %j as %s', async (summary, label, tone) => {
      await h.ready();
      answer(pr, summary);
      expect(chip()!.textContent).toBe(label);
      expect(chip()!.className).toBe(`git-chip-btn ci ${tone}`);
    });

    it('marks a draft, names the failing checks on hover, and opens the PR on click', async () => {
      await h.ready();
      answer({ ...pr, isDraft: true }, checks(0, 2, 0, ['lint', 'build']));
      expect(chip()!.textContent).toBe('#12 draft · ✗ 2 failing');
      expect(chip()!.title).toBe('Add the thing\nFailing: lint, build\nOpen on GitHub');
      chip()!.click();
      expect(h.fake.mock.tabs.create).toHaveBeenCalledWith({ url: pr.url });
    });

    it('says when the PR is merged and offers to archive the workspace, asking twice', async () => {
      await h.ready();
      answer({ ...pr, state: 'MERGED' }, checks(5, 0, 0));
      expect(chip()!.textContent).toBe('#12 · merged');
      expect(chip()!.className).toBe('git-chip-btn ci merged');
      const archive = $('git-branch').querySelector<HTMLButtonElement>('.git-archive')!;
      expect(archive.textContent).toBe('Archive workspace');
      archive.click();
      expect(archive.textContent).toBe('Archive?');
      expect(h.archived).toEqual([]);
      archive.click();
      expect(h.archived).toEqual(['ws-a']);
    });

    it('disarms the archive button after three seconds, like every other confirmation', async () => {
      await h.ready();
      answer({ ...pr, state: 'MERGED' }, checks(5, 0, 0));
      const archive = () => $('git-branch').querySelector<HTMLButtonElement>('.git-archive')!;
      archive().click();
      expect(archive().textContent).toBe('Archive?');
      vi.advanceTimersByTime(3000);
      expect(archive().textContent).toBe('Archive workspace');
      archive().click();
      expect(h.archived).toEqual([]);
    });

    it('offers to create a PR when the branch has none, pushing first', async () => {
      await h.ready();
      answer(null, null);
      const create = $('git-branch').querySelector<HTMLButtonElement>('.git-create-pr')!;
      expect(create.textContent).toBe('Create PR');
      expect(create.title).toBe('Push main and open a draft pull request for it');
      create.click();
      expect(h.sentOfType('gitCreatePr')).toEqual([{ type: 'gitCreatePr', id: 'ws-a' }]);
      expect(create.disabled).toBe(true);
      create.click();
      expect(h.sentOfType('gitCreatePr')).toHaveLength(1);
      h.view.setResult({
        type: 'gitResult',
        id: 'ws-a',
        action: 'pr',
        ok: true,
        message: 'Opened https://github.com/acme/app/pull/13',
        url: 'https://github.com/acme/app/pull/13',
      });
      expect(h.fake.mock.tabs.create).toHaveBeenCalledWith({ url: 'https://github.com/acme/app/pull/13' });
      answer(pr, null);
      expect($('git-branch').querySelector('.git-create-pr')).toBeNull();
    });

    it('does not offer to create a PR for a detached HEAD', async () => {
      await h.ready(gitState({ branch: null }));
      answer(null, null);
      expect($('git-branch').querySelector('.git-create-pr')).toBeNull();
    });

    it('shows no chip when the branch has no PR, or the answer is for another workspace', async () => {
      await h.ready();
      answer(null, null);
      expect(chip()).toBeNull();
      h.view.setChecks({ type: 'gitChecks', id: 'ws-b', pr, checks: checks(1, 0, 0), error: null });
      expect(chip()).toBeNull();
    });
  });
});
