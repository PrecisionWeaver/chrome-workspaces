// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlToHelper, GitCommit, GitFile, GitState, WorkspaceStatus } from '../../shared/protocol';
import { createGitView, type GitView } from '../src/git-view';
import { closeMenu } from '../src/menu';
import { installChrome } from './chrome-mock';
import { isolateDocumentListeners, loadPanelHtml, makeWorkspace } from './fixtures';

isolateDocumentListeners();

const NOW = Date.parse('2026-03-10T12:00:00.000Z');

let fake: ReturnType<typeof installChrome>;
let view: GitView;
let sent: ControlToHelper[];
let toggled: number;
let statuses: Record<string, WorkspaceStatus>;
const workspace = makeWorkspace({ id: 'ws-a' });

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (selector: string, root: ParentNode = document) => [...root.querySelectorAll(selector)].map((node) => node.textContent);
const click = (selector: string, root: ParentNode = document) => (root.querySelector(selector) as HTMLElement).click();
const sentOfType = <T extends ControlToHelper['type']>(type: T) =>
  sent.filter((message): message is Extract<ControlToHelper, { type: T }> => message.type === type);

const file = (path: string, index = ' ', worktree = 'M', from?: string): GitFile => ({ path, index, worktree, ...(from ? { from } : {}) });
const commit = (n: number, overrides: Partial<GitCommit> = {}): GitCommit => ({
  sha: `sha${n}`,
  short: `abc${n}`,
  author: 'octocat',
  date: new Date(NOW - n * 3_600_000).toISOString(),
  refs: [],
  parents: [`sha${n + 1}`],
  subject: `Commit ${n}`,
  ...overrides,
});
const gitState = (overrides: Partial<GitState> = {}): GitState => ({
  root: '/Users/me/acme',
  worktree: null,
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  files: [],
  commits: [],
  ...overrides,
});
const setState = (state: GitState | null, error: string | null = null, id = 'ws-a') => view.setState({ type: 'git', id, state, error });

/**
 * A view for ws-a with its first answer in, and the requests that took out of the way.
 * A first answer names the branch, which asks again at once for that branch's checks, so a second answers that.
 */
async function ready(state: GitState | null = gitState()) {
  view.setWorkspace(workspace);
  await vi.advanceTimersByTimeAsync(0);
  setState(state);
  setState(state);
  sent.length = 0;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = installChrome();
  loadPanelHtml();
  sent = [];
  toggled = 0;
  statuses = {};
  closeMenu();
  view = createGitView({ send: (message) => (sent.push(message), true), onToggle: () => void toggled++, status: (id) => statuses[id] ?? null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('loading', () => {
  it('asks for status and checks when pointed at a workspace, and does nothing for the same one again', async () => {
    view.setWorkspace(workspace);
    expect(sent).toEqual([
      { type: 'git', id: 'ws-a' },
      { type: 'gitChecks', id: 'ws-a' },
    ]);
    view.setWorkspace(workspace);
    expect(sent).toHaveLength(2);
  });

  it('shows nothing, and asks for nothing, without a workspace', () => {
    view.setWorkspace(undefined);
    view.refresh();
    expect(sent).toEqual([]);
    expect($('git-branch').children).toHaveLength(0);
  });

  it('waits for an answer before asking again, and the refresh button shows it', async () => {
    view.setWorkspace(workspace);
    expect($<HTMLButtonElement>('git-refresh').disabled).toBe(true);
    view.refresh();
    expect(sentOfType('git')).toHaveLength(1);
    setState(null);
    expect($<HTMLButtonElement>('git-refresh').disabled).toBe(false);
    view.refresh();
    expect(sentOfType('git')).toHaveLength(2);
  });

  it('gives up waiting for an answer after thirty seconds, and asks again', () => {
    view.setWorkspace(workspace);
    vi.advanceTimersByTime(29_999);
    expect(sentOfType('git')).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sentOfType('git')).toHaveLength(2);
  });

  it('asks about checks at most once a minute, but about status every poll', async () => {
    await ready();
    // Each poll is answered, as the helper would.
    for (let poll = 0; poll < 11; poll++) {
      vi.advanceTimersByTime(5000);
      setState(gitState());
    }
    expect(sentOfType('git')).toHaveLength(11);
    expect(sentOfType('gitChecks')).toEqual([]);
    // Exactly a minute is not yet over a minute.
    vi.advanceTimersByTime(5000);
    setState(gitState());
    expect(sentOfType('gitChecks')).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(sentOfType('gitChecks')).toHaveLength(1);
  });

  it('polls every five seconds while visible', async () => {
    await ready();
    vi.advanceTimersByTime(5000);
    expect(sentOfType('git')).toHaveLength(1);
    setState(gitState());
    vi.advanceTimersByTime(5000);
    expect(sentOfType('git')).toHaveLength(2);
  });

  it('ignores an answer for another workspace, and one that arrives after switching', async () => {
    view.setWorkspace(workspace);
    setState(gitState({ branch: 'other' }), null, 'ws-b');
    expect($('git-branch').children).toHaveLength(0);

    setState(gitState({ branch: 'mine' }));
    view.setWorkspace(makeWorkspace({ id: 'ws-b' }));
    expect($('git-branch').children).toHaveLength(0);
    setState(gitState({ branch: 'mine' }));
    expect($('git-branch').children).toHaveLength(0);
  });

  it('shows an error from git, and clears it', async () => {
    view.setWorkspace(workspace);
    setState(null, 'not a git repository');
    expect($('git-error').hidden).toBe(false);
    expect($('git-error').textContent).toBe('not a git repository');
    setState(gitState());
    expect($('git-error').hidden).toBe(true);
  });
});

describe('collapsing', () => {
  it('does not poll while collapsed, and refreshes on expanding, remembering the state', async () => {
    await ready();
    click('#git-toggle');
    expect($('git').classList.contains('collapsed')).toBe(true);
    expect(fake.storage.local.gitCollapsed).toBe(true);
    vi.advanceTimersByTime(10_000);
    view.refresh();
    expect(sent).toEqual([]);

    click('#git-toggle');
    expect(fake.storage.local.gitCollapsed).toBe(false);
    expect(sentOfType('git')).toHaveLength(1);
  });

  it('starts collapsed when it was left that way', async () => {
    fake.storage.local.gitCollapsed = true;
    loadPanelHtml();
    createGitView({ send: () => true, onToggle: () => {}, status: () => null });
    await vi.advanceTimersByTimeAsync(0);
    expect($('git').classList.contains('collapsed')).toBe(true);
  });
});

describe('the branch line', () => {
  it('shows the branch, with a button to switch', async () => {
    await ready(gitState({ branch: 'feature/x' }));
    expect(text('.git-branch-name span:nth-child(2)')).toEqual(['feature/x']);
    // A long name is cut with an ellipsis, so the tooltip carries all of it.
    expect($('git-branch').querySelector<HTMLElement>('.git-branch-name')!.title).toBe('feature/x\nSwitch branch');
  });

  it('says detached HEAD when there is no branch', async () => {
    await ready(gitState({ branch: null }));
    expect(text('.git-branch-name span:nth-child(2)')).toEqual(['detached HEAD']);
  });

  it('shows commits ahead and behind, only when there are some', async () => {
    await ready(gitState({ ahead: 2, behind: 3 }));
    expect(text('.git-sync')).toEqual(['↑2', '↓3']);
    setState(gitState());
    expect(text('.git-sync')).toEqual([]);
  });

  it('says when Claude is in a linked worktree', async () => {
    await ready(gitState({ worktree: 'feature-a' }));
    expect(text('.git-worktree')).toEqual(['worktree · feature-a']);
    expect($('git-branch').querySelector<HTMLElement>('.git-worktree')!.title).toContain('/Users/me/acme');
  });

  it('says what Claude is doing, redrawn on request', async () => {
    await ready();
    expect(text('.git-claude')).toEqual([]);
    statuses['ws-a'] = 'needs_input';
    view.renderStatus();
    expect(text('.git-claude')).toEqual(['Claude needs input']);
    expect($('git-branch').querySelector<HTMLElement>('.git-claude')!.dataset.status).toBe('needs_input');
    statuses['ws-a'] = 'working';
    view.renderStatus();
    expect(text('.git-claude')).toEqual(['Claude is working']);
    statuses['ws-a'] = 'idle';
    view.renderStatus();
    expect(text('.git-claude')).toEqual(['Claude is idle']);
  });

  describe('the pull request chip', () => {
    const pr = { number: 12, title: 'Add the thing', url: 'https://github.com/acme/app/pull/12', isDraft: false, reviewDecision: null };
    const checks = (passed: number, failed: number, pending: number, failing: string[] = []) => ({ passed, failed, pending, failing });
    const chip = () => $('git-branch').querySelector<HTMLButtonElement>('.ci');
    const answer = (prValue: typeof pr | null, checksValue: ReturnType<typeof checks> | null) =>
      view.setChecks({ type: 'gitChecks', id: 'ws-a', pr: prValue, checks: checksValue, error: null });

    it.each([
      [checks(5, 0, 0), '#12 · ✓ 5 passing', 'good'],
      [checks(3, 0, 2), '#12 · ● 2 running', 'wait'],
      [checks(3, 1, 2, ['lint']), '#12 · ✗ 1 failing', 'bad'],
      [checks(0, 0, 0), '#12 · no checks', ''],
      [null, '#12 · no checks', ''],
    ])('summarises %j as %s', async (summary, label, tone) => {
      await ready();
      answer(pr, summary);
      expect(chip()!.textContent).toBe(label);
      expect(chip()!.className).toBe(`git-chip-btn ci ${tone}`);
    });

    it('marks a draft, names the failing checks on hover, and opens the PR on click', async () => {
      await ready();
      answer({ ...pr, isDraft: true }, checks(0, 2, 0, ['lint', 'build']));
      expect(chip()!.textContent).toBe('#12 draft · ✗ 2 failing');
      expect(chip()!.title).toBe('Add the thing\nFailing: lint, build\nOpen on GitHub');
      chip()!.click();
      expect(fake.mock.tabs.create).toHaveBeenCalledWith({ url: pr.url });
    });

    it('shows no chip when the branch has no PR, or the answer is for another workspace', async () => {
      await ready();
      answer(null, null);
      expect(chip()).toBeNull();
      view.setChecks({ type: 'gitChecks', id: 'ws-b', pr, checks: checks(1, 0, 0), error: null });
      expect(chip()).toBeNull();
    });

    it('forgets the PR when the branch changes, and asks again at once', async () => {
      await ready();
      answer(pr, checks(1, 0, 0));
      sent.length = 0;
      setState(gitState({ branch: 'other' }));
      expect(chip()).toBeNull();
      expect(sentOfType('gitChecks')).toHaveLength(1);
    });
  });
});

describe('changes', () => {
  it('splits staged from unstaged, with counts and status letters', async () => {
    await ready(gitState({ files: [file('a.ts', 'M', ' '), file('b.ts', ' ', 'M'), file('c.ts', 'A', 'M'), file('d.ts', ' ', 'D'), file('e.ts', '?', '?')] }));
    expect(text('#git-changes h3')).toEqual(['Staged changes2−', 'Changes4+']);
    const [staged, unstaged] = [...document.querySelectorAll('#git-changes h3')].map((heading) => {
      const rows: string[] = [];
      for (let node = heading.nextElementSibling; node?.classList.contains('git-file'); node = node.nextElementSibling)
        rows.push(`${node.querySelector('.git-file-name')?.textContent}:${node.querySelector('.git-letter')?.textContent}`);
      return rows;
    });
    expect(staged).toEqual(['a.ts:M', 'c.ts:A']);
    expect(unstaged).toEqual(['b.ts:M', 'c.ts:M', 'd.ts:D', 'e.ts:U']);
  });

  it('shows the name with its folder, and where a renamed file came from', async () => {
    await ready(gitState({ files: [file('src/deep/new.ts', 'R', ' ', 'src/old.ts'), file('top.ts')] }));
    const rows = [...document.querySelectorAll<HTMLElement>('.git-file')];
    expect(text('.git-file-name', rows[0]!)).toEqual(['new.ts']);
    expect(text('.git-file-dir', rows[0]!)).toEqual(['src/deep']);
    expect(rows[0]!.title).toBe('src/old.ts → src/deep/new.ts');
    expect(text('.git-file-dir', rows[1]!)).toEqual(['']);
    expect(rows[1]!.title).toBe('top.ts');
  });

  it('says the tree is clean when nothing changed, and shows no commit box', async () => {
    await ready(gitState({ files: [] }));
    expect(text('.git-empty')).toEqual(['Working tree clean']);
    expect($('git-save').hidden).toBe(true);
  });

  it('stages and unstages one file or all of them', async () => {
    await ready(gitState({ files: [file('a.ts', 'M', ' '), file('b.ts', ' ', 'M')] }));
    const [unstageAll, stageAll] = [...document.querySelectorAll<HTMLElement>('.git-bulk .git-act')];
    unstageAll!.click();
    stageAll!.click();
    click('.git-file:nth-of-type(1) .git-act[title="Unstage"]');
    click('.git-file .git-act[title="Stage"]');
    expect(sentOfType('gitStage')).toEqual([
      { type: 'gitStage', id: 'ws-a', paths: [], stage: false },
      { type: 'gitStage', id: 'ws-a', paths: [], stage: true },
      { type: 'gitStage', id: 'ws-a', paths: ['a.ts'], stage: false },
      { type: 'gitStage', id: 'ws-a', paths: ['b.ts'], stage: true },
    ]);
  });

  it('asks twice before discarding, and disarms after three seconds', async () => {
    await ready(gitState({ files: [file('b.ts', ' ', 'M')] }));
    const discard = document.querySelector<HTMLButtonElement>('.git-act[title="Discard changes"]')!;
    discard.click();
    expect(discard.textContent).toBe('Discard?');
    expect(discard.classList.contains('armed')).toBe(true);
    expect(sentOfType('gitDiscard')).toEqual([]);
    vi.advanceTimersByTime(3000);
    expect(discard.textContent).toBe('↶');
    discard.click();
    expect(sentOfType('gitDiscard')).toEqual([]);
    discard.click();
    expect(sentOfType('gitDiscard')).toEqual([{ type: 'gitDiscard', id: 'ws-a', paths: ['b.ts'] }]);
  });

  it('words the discard for an untracked file as a delete', async () => {
    await ready(gitState({ files: [file('new.ts', '?', '?')] }));
    const discard = document.querySelector<HTMLButtonElement>('.git-act[title="Delete this new file"]')!;
    discard.click();
    expect(discard.textContent).toBe('Delete?');
  });

  it('does not open the diff when an action button is clicked', async () => {
    await ready(gitState({ files: [file('b.ts')] }));
    click('.git-act[title="Stage"]');
    expect(sentOfType('gitDiff')).toEqual([]);
  });

  it('highlights files that changed since the last answer, for five seconds', async () => {
    await ready(gitState({ files: [file('a.ts')] }));
    expect(document.querySelectorAll('.git-file.fresh')).toHaveLength(0);

    setState(gitState({ files: [file('a.ts'), file('b.ts')] }));
    expect(text('.git-file.fresh .git-file-name')).toEqual(['b.ts']);
    setState(gitState({ files: [file('a.ts', ' ', 'D'), file('b.ts')] }));
    expect(text('.git-file.fresh .git-file-name').sort()).toEqual(['a.ts', 'b.ts']);

    vi.advanceTimersByTime(5000);
    expect(document.querySelectorAll('.git-file.fresh')).toHaveLength(0);
  });

  it('opens the working-tree diff for a file, by click or Enter', async () => {
    await ready(gitState({ files: [file('a.ts')] }));
    const row = document.querySelector<HTMLElement>('.git-file')!;
    row.click();
    expect(sentOfType('gitDiff')).toEqual([{ type: 'gitDiff', id: 'ws-a', path: 'a.ts' }]);
    expect($('diff-title').textContent).toBe('a.ts');
    expect($('diff-meta').textContent).toBe('Working tree against HEAD');
    expect($('diff').hidden).toBe(false);
    expect(toggled).toBe(1);

    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sentOfType('gitDiff')).toHaveLength(2);
    expect(toggled).toBe(1);
  });
});

describe('saving', () => {
  const stagedState = gitState({ files: [file('a.ts', 'M', ' ')] });
  const message = () => $<HTMLTextAreaElement>('git-message');
  const typeMessage = (value: string) => {
    message().value = value;
    message().dispatchEvent(new Event('input'));
  };

  it('shows the commit box once something is staged, with the button waiting for a message', async () => {
    await ready(stagedState);
    expect($('git-save').hidden).toBe(false);
    expect($<HTMLButtonElement>('git-save-btn').disabled).toBe(true);
    expect($('git-save-btn').title).toBe('Commit 1 staged file');
    typeMessage('Fix it');
    expect($<HTMLButtonElement>('git-save-btn').disabled).toBe(false);
    typeMessage('   ');
    expect($<HTMLButtonElement>('git-save-btn').disabled).toBe(true);
  });

  it('keeps the box once a message is started, but disables the button with nothing staged', async () => {
    await ready(gitState({ files: [file('a.ts', ' ', 'M')] }));
    expect($('git-save').hidden).toBe(true);
    typeMessage('Half written');
    expect($('git-save').hidden).toBe(false);
    expect($<HTMLButtonElement>('git-save-btn').disabled).toBe(true);
    expect($('git-save-btn').title).toBe('Stage something first');
  });

  it('commits the message, and disables the button while it works', async () => {
    await ready(stagedState);
    typeMessage('Fix it');
    click('#git-save-btn');
    expect(sentOfType('gitSave')).toEqual([{ type: 'gitSave', id: 'ws-a', message: 'Fix it' }]);
    expect($<HTMLButtonElement>('git-save-btn').disabled).toBe(true);
    click('#git-save-btn');
    expect(sentOfType('gitSave')).toHaveLength(1);
  });

  it('commits on Cmd+Enter or Ctrl+Enter, and leaves a plain Enter for a new line', async () => {
    await ready(stagedState);
    typeMessage('Fix it');
    const plain = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    message().dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(sentOfType('gitSave')).toEqual([]);

    const meta = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true });
    message().dispatchEvent(meta);
    expect(meta.defaultPrevented).toBe(true);
    expect(sentOfType('gitSave')).toHaveLength(1);
  });

  it('does not commit an empty message by keyboard', async () => {
    await ready(stagedState);
    message().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    expect(sentOfType('gitSave')).toEqual([]);
  });

  it('clears the message after a commit, but not after another action, and refreshes at once', async () => {
    await ready(stagedState);
    typeMessage('Fix it');
    view.setResult({ type: 'gitResult', id: 'ws-a', action: 'stage', ok: true, message: 'Staged' });
    expect(message().value).toBe('Fix it');
    setState(stagedState);
    view.setResult({ type: 'gitResult', id: 'ws-a', action: 'commit', ok: true, message: 'Committed' });
    expect(message().value).toBe('');
    expect(sentOfType('git').length).toBeGreaterThan(0);
  });

  it('shows the result as a notice for six seconds, good or bad', async () => {
    await ready(stagedState);
    view.setResult({ type: 'gitResult', id: 'ws-a', action: 'commit', ok: true, message: 'Committed abc123' });
    expect($('git-notice').hidden).toBe(false);
    expect($('git-notice').className).toBe('ok');
    expect($('git-notice').textContent).toBe('Committed abc123');
    vi.advanceTimersByTime(6000);
    expect($('git-notice').hidden).toBe(true);

    view.setResult({ type: 'gitResult', id: 'ws-a', action: 'commit', ok: false, message: 'hook failed' });
    expect($('git-notice').className).toBe('bad');
  });

  it('re-enables the button after a failed commit', async () => {
    await ready(stagedState);
    typeMessage('Fix it');
    click('#git-save-btn');
    view.setResult({ type: 'gitResult', id: 'ws-a', action: 'commit', ok: false, message: 'hook failed' });
    expect($<HTMLButtonElement>('git-save-btn').disabled).toBe(false);
  });

  it('ignores a result for another workspace', async () => {
    await ready(stagedState);
    view.setResult({ type: 'gitResult', id: 'ws-b', action: 'commit', ok: true, message: 'Committed' });
    expect($('git-notice').hidden).toBe(true);
  });

  it('forgets a half-written message when the workspace changes', async () => {
    await ready(stagedState);
    typeMessage('Half');
    view.setWorkspace(makeWorkspace({ id: 'ws-b' }));
    expect(message().value).toBe('');
  });
});

describe('commits and the diff view', () => {
  const commits = [commit(1, { refs: ['HEAD -> main', 'origin/main', 'tag: v1'] }), commit(2, { parents: ['sha3', 'sha4'] }), commit(3, { parents: [] })];
  const rows = () => [...document.querySelectorAll<HTMLElement>('.git-commit')];

  it('lists commits with their subject, age and a graph, merges drawn hollow', async () => {
    await ready(gitState({ commits }));
    expect(text('#git-commits h3')).toEqual(['Commits3']);
    expect(text('.git-subject')).toEqual(['Commit 1', 'Commit 2', 'Commit 3']);
    expect(text('.git-when')).toEqual(['1h ago', '2h ago', '3h ago']);
    expect(rows()[0]!.querySelector('svg.git-graph')).not.toBeNull();
    expect(rows()[0]!.querySelector('circle')!.getAttribute('fill')).not.toBeNull();
    expect(rows()[1]!.querySelector<SVGElement>('circle')!.style.fill).toBe('var(--list-bg)');
    expect(rows()[0]!.title).toContain('abc1 · octocat');
  });

  it('shows the first ref by name and folds the rest into a count with the names on hover', async () => {
    await ready(gitState({ commits }));
    expect(text('.git-ref', rows()[0]!)).toEqual(['main', '+2']);
    expect(rows()[0]!.querySelector<HTMLElement>('.git-ref.head')).not.toBeNull();
    expect(rows()[0]!.querySelector<HTMLElement>('.git-ref.more')!.title).toBe('origin/main\ntag: v1');
    expect(rows()[1]!.querySelector('.git-refs')).toBeNull();
  });

  it('tones tags and heads', async () => {
    await ready(gitState({ commits: [commit(1, { refs: ['tag: v2'] }), commit(2, { refs: ['HEAD'] }), commit(3, { refs: ['origin/x'] })] }));
    expect(rows().map((row) => row.querySelector('.git-ref')!.className)).toEqual(['git-ref tag', 'git-ref head', 'git-ref']);
  });

  it('shows no commits section when there are none', async () => {
    await ready(gitState({ commits: [] }));
    expect($('git-commits').children).toHaveLength(0);
  });

  it("opens a commit's diff view, asking for its files", async () => {
    await ready(gitState({ commits }));
    rows()[0]!.click();
    expect(sentOfType('gitCommit')).toEqual([{ type: 'gitCommit', id: 'ws-a', sha: 'sha1' }]);
    expect($('diff-title').textContent).toBe('Commit 1');
    expect($('diff-meta').textContent).toContain('abc1 · octocat');
    expect($('diff-body').textContent).toBe('Loading…');
    expect($('diff-files').hidden).toBe(true);
  });

  it('lists the commit’s files and shows the first one’s diff', async () => {
    await ready(gitState({ commits }));
    rows()[0]!.click();
    sent.length = 0;
    view.setCommit({
      type: 'gitCommit',
      id: 'ws-a',
      sha: 'sha1',
      error: null,
      files: [
        { path: 'a.ts', status: 'M' },
        { path: 'dir/b.ts', status: 'A' },
      ],
    });
    expect(text('#diff-files .git-file-name')).toEqual(['a.ts', 'b.ts']);
    expect($('diff-files').hidden).toBe(false);
    expect(sentOfType('gitDiff')).toEqual([{ type: 'gitDiff', id: 'ws-a', path: 'a.ts', sha: 'sha1' }]);
    expect(document.querySelector<HTMLElement>('#diff-files .git-file')!.classList.contains('selected')).toBe(true);

    document.querySelectorAll<HTMLElement>('#diff-files .git-file')[1]!.click();
    expect(sentOfType('gitDiff')[1]).toEqual({ type: 'gitDiff', id: 'ws-a', path: 'dir/b.ts', sha: 'sha1' });
    expect([...document.querySelectorAll('#diff-files .git-file')].map((row) => row.classList.contains('selected'))).toEqual([false, true]);
  });

  it('says so when a commit changed no files, or could not be read', async () => {
    await ready(gitState({ commits }));
    rows()[0]!.click();
    view.setCommit({ type: 'gitCommit', id: 'ws-a', sha: 'sha1', error: null, files: [] });
    expect($('diff-body').textContent).toBe('No files changed.');
    expect($('diff-files').hidden).toBe(true);
    view.setCommit({ type: 'gitCommit', id: 'ws-a', sha: 'sha1', error: 'bad object', files: [] });
    expect($('diff-body').textContent).toBe('Could not read the commit: bad object');
  });

  it('ignores a commit answer for a commit that is no longer open', async () => {
    await ready(gitState({ commits }));
    rows()[0]!.click();
    view.setCommit({ type: 'gitCommit', id: 'ws-a', sha: 'sha2', error: null, files: [{ path: 'x.ts', status: 'M' }] });
    expect(document.querySelectorAll('#diff-files .git-file')).toHaveLength(0);
  });

  describe('a diff', () => {
    const open = async () => {
      await ready(gitState({ files: [file('a.ts')] }));
      click('.git-file');
    };
    const answer = (diff: string, extra: Partial<Extract<Parameters<GitView['setDiff']>[0], { type: 'gitDiff' }>> = {}) =>
      view.setDiff({ type: 'gitDiff', id: 'ws-a', path: 'a.ts', sha: null, diff, truncated: false, error: null, ...extra });
    const lines = () => [...document.querySelectorAll('#diff-body .diff-line')].map((line) => [line.className.replace('diff-line ', ''), line.textContent]);

    it('classes each line, treating file headers as meta rather than additions or removals', async () => {
      await open();
      answer(
        [
          'diff --git a/a.ts b/a.ts',
          'index 1..2 100644',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1,2 +1,2 @@',
          ' context',
          '-old',
          '+new',
          '',
          'new file mode 100644',
        ].join('\n'),
      );
      expect(lines()).toEqual([
        ['meta', 'diff --git a/a.ts b/a.ts'],
        ['meta', 'index 1..2 100644'],
        ['meta', '--- a/a.ts'],
        ['meta', '+++ b/a.ts'],
        ['hunk', '@@ -1,2 +1,2 @@'],
        ['ctx', ' context'],
        ['del', '-old'],
        ['add', '+new'],
        ['ctx', ' '],
        ['meta', 'new file mode 100644'],
      ]);
    });

    it('says so when there is no textual change', async () => {
      await open();
      answer('  \n');
      expect($('diff-body').textContent).toBe('No textual changes (binary file, mode change or empty).');
    });

    it('cuts a long diff at four thousand lines and says so', async () => {
      await open();
      answer(Array.from({ length: 4100 }, () => '+x').join('\n'));
      expect(document.querySelectorAll('#diff-body .diff-line')).toHaveLength(4000);
      expect(text('#diff-body .git-empty')).toEqual(['Diff truncated.']);
    });

    it('says so when the helper truncated it', async () => {
      await open();
      answer('+x', { truncated: true });
      expect(text('#diff-body .git-empty')).toEqual(['Diff truncated.']);
    });

    it('shows an error from reading it', async () => {
      await open();
      answer('', { error: 'boom' });
      expect($('diff-body').textContent).toBe('Could not read the diff: boom');
    });

    it('ignores a diff for another file, another commit or another workspace', async () => {
      await open();
      answer('+x', { path: 'other.ts' });
      answer('+x', { sha: 'sha1' });
      answer('+x', { id: 'ws-b' });
      expect($('diff-body').textContent).toBe('Loading…');
    });
  });

  describe('closing', () => {
    it('closes from the button or Escape, telling the panel once, and only when open', async () => {
      await ready(gitState({ files: [file('a.ts')] }));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(toggled).toBe(0);

      click('.git-file');
      click('#diff-close');
      expect(view.isOpen).toBe(false);
      expect($('diff').hidden).toBe(true);
      expect(toggled).toBe(2);

      click('.git-file');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(view.isOpen).toBe(false);
      view.close();
      expect(toggled).toBe(4);
    });

    it('closes without a toggle when the workspace changes underneath it', async () => {
      await ready(gitState({ files: [file('a.ts')] }));
      click('.git-file');
      view.setWorkspace(makeWorkspace({ id: 'ws-b' }));
      expect($('diff').hidden).toBe(true);
      expect(toggled).toBe(1);
    });
  });
});

describe('switching branch', () => {
  const branches = [
    { name: 'main', current: true, upstream: 'origin/main' },
    { name: 'feature/x', current: false, upstream: null },
  ];
  const menu = () => document.querySelector('.branch-menu') as HTMLElement | null;

  it('asks for the branches and shows a loading menu', async () => {
    await ready();
    click('.git-branch-name');
    expect(sentOfType('gitBranches')).toEqual([{ type: 'gitBranches', id: 'ws-a' }]);
    expect(menu()!.textContent).toBe('Loading branches…');
  });

  it('lists them, ticking and disabling the current one, and switches on click', async () => {
    await ready();
    click('.git-branch-name');
    view.setBranches({ type: 'gitBranches', id: 'ws-a', branches, error: null });
    const items = [...menu()!.querySelectorAll<HTMLButtonElement>('button')];
    expect(items.map((item) => item.textContent)).toEqual(['✓ main', 'feature/x']);
    expect(items.map((item) => item.disabled)).toEqual([true, false]);
    expect(items.map((item) => item.title)).toEqual(['main\ntracks origin/main', 'feature/x\nlocal only']);
    items[1]!.click();
    expect(sentOfType('gitSwitch')).toEqual([{ type: 'gitSwitch', id: 'ws-a', branch: 'feature/x' }]);
    expect(menu()).toBeNull();
  });

  it('says so when there are no branches', async () => {
    await ready();
    click('.git-branch-name');
    view.setBranches({ type: 'gitBranches', id: 'ws-a', branches: [], error: null });
    expect(menu()!.textContent).toBe('No branches');
  });

  it('reports an error listing them', async () => {
    await ready();
    click('.git-branch-name');
    view.setBranches({ type: 'gitBranches', id: 'ws-a', branches: [], error: 'no remote' });
    expect($('git-notice').textContent).toBe('Could not list branches: no remote');
    expect($('git-notice').className).toBe('bad');
  });

  it('does not open a menu nobody asked for, or for another workspace', async () => {
    await ready();
    view.setBranches({ type: 'gitBranches', id: 'ws-a', branches, error: null });
    expect(menu()).toBeNull();
    click('.git-branch-name');
    view.setBranches({ type: 'gitBranches', id: 'ws-b', branches, error: null });
    expect(menu()!.textContent).toBe('Loading branches…');
  });
});

describe('comparing with main', () => {
  const compare = {
    base: 'origin/main',
    mergeBase: 'abc123',
    ahead: 3,
    files: [
      { path: 'a.ts', status: 'M' },
      { path: 'b.ts', status: 'A' },
    ],
  };
  const answer = (value: typeof compare | null, error: string | null = null) => view.setCompare({ type: 'gitCompare', id: 'ws-a', compare: value, error });

  it('opens a diff view titled for the branch, and asks for the comparison', async () => {
    await ready(gitState({ branch: 'feature/x' }));
    click('.git-chip-btn:not(.ci)');
    expect(sentOfType('gitCompare')).toEqual([{ type: 'gitCompare', id: 'ws-a' }]);
    expect($('diff-title').textContent).toBe('feature/x vs main');
    expect($('diff').hidden).toBe(false);
  });

  it('says how far ahead the branch is, lists the files and shows the first against the base', async () => {
    await ready();
    click('.git-chip-btn');
    sent.length = 0;
    answer(compare);
    expect($('diff-meta').textContent).toBe('3 commits ahead of origin/main (forked at abc123)');
    expect(text('#diff-files .git-file-name')).toEqual(['a.ts', 'b.ts']);
    expect(sentOfType('gitDiff')).toEqual([{ type: 'gitDiff', id: 'ws-a', path: 'a.ts', base: true }]);
    document.querySelectorAll<HTMLElement>('#diff-files .git-file')[1]!.click();
    expect(sentOfType('gitDiff')[1]).toEqual({ type: 'gitDiff', id: 'ws-a', path: 'b.ts', base: true });
  });

  it('uses the singular for one commit', async () => {
    await ready();
    click('.git-chip-btn');
    answer({ ...compare, ahead: 1 });
    expect($('diff-meta').textContent).toContain('1 commit ahead');
  });

  it('shows the base-relative diff for the selected file', async () => {
    await ready();
    click('.git-chip-btn');
    answer(compare);
    view.setDiff({ type: 'gitDiff', id: 'ws-a', path: 'a.ts', sha: null, diff: '+added', truncated: false, error: null });
    expect(text('#diff-body .diff-line')).toEqual(['+added']);
  });

  it('says so when nothing differs, or the comparison failed', async () => {
    await ready();
    click('.git-chip-btn');
    answer({ ...compare, files: [] });
    expect($('diff-body').textContent).toBe('No differences from the main branch.');
    expect($('diff-files').hidden).toBe(true);
    answer(null, 'no merge base');
    expect($('diff-body').textContent).toBe('no merge base');
    answer(null);
    expect($('diff-body').textContent).toBe('Nothing to compare.');
  });

  it('ignores an answer when no comparison is open, or for another workspace', async () => {
    await ready();
    answer(compare);
    expect($('diff-meta').textContent).toBe('');
    click('.git-chip-btn');
    view.setCompare({ type: 'gitCompare', id: 'ws-b', compare, error: null });
    expect($('diff-files').children).toHaveLength(0);
  });

  it('stops comparing once the view closes', async () => {
    await ready();
    click('.git-chip-btn');
    click('#diff-close');
    sent.length = 0;
    answer(compare);
    expect(sent).toEqual([]);
  });
});
