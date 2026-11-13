// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolateDocumentListeners, loadPanelHtml, makeWorkspace } from '../../testing/fixtures';
import { GIT_NOW, GIT_WORKSPACE, type GitViewHarness, gitFile, gitState, mountGitView } from '../../testing/git-fixtures';
import { createGitView } from './git-view';

isolateDocumentListeners();

let h: GitViewHarness;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const click = (selector: string, root: ParentNode = document) => (root.querySelector(selector) as HTMLElement).click();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(GIT_NOW);
  h = mountGitView();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('loading', () => {
  it('asks for status and checks when pointed at a workspace, and does nothing for the same one again', async () => {
    h.view.setWorkspace(GIT_WORKSPACE);
    expect(h.sent).toEqual([
      { type: 'git', id: 'ws-a' },
      { type: 'gitChecks', id: 'ws-a' },
    ]);
    h.view.setWorkspace(GIT_WORKSPACE);
    expect(h.sent).toHaveLength(2);
  });

  it('shows nothing, and asks for nothing, without a workspace', () => {
    h.view.setWorkspace(undefined);
    h.view.refresh();
    expect(h.sent).toEqual([]);
    expect($('git-branch').children).toHaveLength(0);
  });

  it('waits for an answer before asking again, and the refresh button shows it', async () => {
    h.view.setWorkspace(GIT_WORKSPACE);
    expect($<HTMLButtonElement>('git-refresh').disabled).toBe(true);
    h.view.refresh();
    expect(h.sentOfType('git')).toHaveLength(1);
    h.setState(null);
    expect($<HTMLButtonElement>('git-refresh').disabled).toBe(false);
    h.view.refresh();
    expect(h.sentOfType('git')).toHaveLength(2);
  });

  it('gives up waiting for an answer after thirty seconds, and asks again', () => {
    h.view.setWorkspace(GIT_WORKSPACE);
    vi.advanceTimersByTime(29_999);
    expect(h.sentOfType('git')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(h.sentOfType('git')).toHaveLength(2);
  });

  it('asks about checks at most once a minute, but about status every poll', async () => {
    await h.ready();
    // Each poll is answered, as the helper would.
    for (let poll = 0; poll < 11; poll++) {
      vi.advanceTimersByTime(5000);
      h.setState(gitState());
    }
    expect(h.sentOfType('git')).toHaveLength(11);
    expect(h.sentOfType('gitChecks')).toEqual([]);
    // Exactly a minute is not yet over a minute.
    vi.advanceTimersByTime(5000);
    h.setState(gitState());
    expect(h.sentOfType('gitChecks')).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(h.sentOfType('gitChecks')).toHaveLength(1);
  });

  it('polls every five seconds while visible', async () => {
    await h.ready();
    vi.advanceTimersByTime(5000);
    expect(h.sentOfType('git')).toHaveLength(1);
    h.setState(gitState());
    vi.advanceTimersByTime(5000);
    expect(h.sentOfType('git')).toHaveLength(2);
  });

  it('ignores an answer for another workspace, and one that arrives after switching', async () => {
    h.view.setWorkspace(GIT_WORKSPACE);
    h.setState(gitState({ branch: 'other' }), null, 'ws-b');
    expect($('git-branch').children).toHaveLength(0);

    h.setState(gitState({ branch: 'mine' }));
    h.view.setWorkspace(makeWorkspace({ id: 'ws-b' }));
    expect($('git-branch').children).toHaveLength(0);
    h.setState(gitState({ branch: 'mine' }));
    expect($('git-branch').children).toHaveLength(0);
  });

  it('shows an error from git, and clears it', async () => {
    h.view.setWorkspace(GIT_WORKSPACE);
    h.setState(null, 'not a git repository');
    expect($('git-error').hidden).toBe(false);
    expect($('git-error').textContent).toBe('not a git repository');
    h.setState(gitState());
    expect($('git-error').hidden).toBe(true);
  });

  it('forgets the PR when the branch changes, and asks again at once', async () => {
    await h.ready();
    h.view.setChecks({
      type: 'gitChecks',
      id: 'ws-a',
      pr: { number: 12, title: 'Add the thing', url: 'https://github.com/acme/app/pull/12', isDraft: false, reviewDecision: null, state: 'OPEN' },
      checks: { passed: 1, failed: 0, pending: 0, failing: [] },
      error: null,
    });
    expect($('git-branch').querySelector('.ci')).not.toBeNull();
    h.sent.length = 0;
    h.setState(gitState({ branch: 'other' }));
    expect($('git-branch').querySelector('.ci')).toBeNull();
    expect(h.sentOfType('gitChecks')).toHaveLength(1);
  });
});

describe('collapsing', () => {
  it('does not poll while collapsed, and refreshes on expanding, remembering the state', async () => {
    await h.ready();
    click('#git-toggle');
    expect($('git').classList.contains('collapsed')).toBe(true);
    expect(h.fake.storage.local.gitCollapsed).toBe(true);
    vi.advanceTimersByTime(10_000);
    h.view.refresh();
    expect(h.sent).toEqual([]);

    click('#git-toggle');
    expect(h.fake.storage.local.gitCollapsed).toBe(false);
    expect(h.sentOfType('git')).toHaveLength(1);
  });

  it('starts collapsed when it was left that way', async () => {
    h.fake.storage.local.gitCollapsed = true;
    loadPanelHtml();
    createGitView({ send: () => true, onToggle: () => {}, status: () => null });
    await vi.advanceTimersByTimeAsync(0);
    expect($('git').classList.contains('collapsed')).toBe(true);
  });
});

describe('results', () => {
  it('shows the result as a notice for six seconds, good or bad', async () => {
    await h.ready();
    h.view.setResult({ type: 'gitResult', id: 'ws-a', action: 'commit', ok: true, message: 'Committed abc123' });
    expect($('git-notice').hidden).toBe(false);
    expect($('git-notice').className).toBe('ok');
    expect($('git-notice').textContent).toBe('Committed abc123');
    vi.advanceTimersByTime(6000);
    expect($('git-notice').hidden).toBe(true);

    h.view.setResult({ type: 'gitResult', id: 'ws-a', action: 'commit', ok: false, message: 'hook failed' });
    expect($('git-notice').className).toBe('bad');
  });

  it('refreshes at once after a good result, so what changed on disk shows before the next poll', async () => {
    await h.ready();
    h.view.setResult({ type: 'gitResult', id: 'ws-a', action: 'stage', ok: true, message: 'Staged' });
    expect(h.sentOfType('git')).toHaveLength(1);
    expect(h.sentOfType('gitChecks')).toHaveLength(1);
  });

  it('ignores a result for another workspace', async () => {
    await h.ready();
    h.view.setResult({ type: 'gitResult', id: 'ws-b', action: 'commit', ok: true, message: 'Committed' });
    expect($('git-notice').hidden).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it('hides the notice when the workspace changes', async () => {
    await h.ready();
    h.view.setResult({ type: 'gitResult', id: 'ws-a', action: 'commit', ok: true, message: 'Committed' });
    h.view.setWorkspace(makeWorkspace({ id: 'ws-b' }));
    expect($('git-notice').hidden).toBe(true);
  });
});

describe('closing the diff view', () => {
  it('closes from the button or Escape, telling the panel once, and only when open', async () => {
    await h.ready(gitState({ files: [gitFile('a.ts')] }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.toggled).toBe(0);

    click('.git-file');
    click('#diff-close');
    expect(h.view.isOpen).toBe(false);
    expect($('diff').hidden).toBe(true);
    expect(h.toggled).toBe(2);

    click('.git-file');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.view.isOpen).toBe(false);
    h.view.close();
    expect(h.toggled).toBe(4);
  });

  it('closes without a toggle when the workspace changes underneath it', async () => {
    await h.ready(gitState({ files: [gitFile('a.ts')] }));
    click('.git-file');
    h.view.setWorkspace(makeWorkspace({ id: 'ws-b' }));
    expect($('diff').hidden).toBe(true);
    expect(h.toggled).toBe(1);
  });
});
