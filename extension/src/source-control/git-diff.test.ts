// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitView } from './git-view';
import { isolateDocumentListeners } from '../../testing/fixtures';
import { GIT_NOW, type GitViewHarness, gitCommit, gitFile, gitState, mountGitView } from '../../testing/git-fixtures';
import { fileRow } from './git-diff';

isolateDocumentListeners();

let h: GitViewHarness;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (selector: string, root: ParentNode = document) => [...root.querySelectorAll(selector)].map((node) => node.textContent);
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

describe('fileRow', () => {
  it('names the file and its folder, tones the status letter, and opens on click or Enter', () => {
    const opened: number[] = [];
    const row = fileRow('D', 'src/a.ts', undefined, () => opened.push(1));
    expect(row.title).toBe('src/a.ts');
    expect(text('.git-file-name', row)).toEqual(['a.ts']);
    expect(text('.git-file-dir', row)).toEqual(['src']);
    expect(row.querySelector('.git-letter')!.className).toBe('git-letter del');
    row.click();
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
    expect(opened).toHaveLength(2);
  });

  it('leaves an unknown letter untoned, marks a fresh row, and keeps action clicks to themselves', () => {
    const opened: number[] = [];
    const action = document.createElement('button');
    const row = fileRow('X', 'a.ts', 'old.ts', () => opened.push(1), true, [action]);
    expect(row.className).toBe('git-file fresh');
    expect(row.title).toBe('old.ts → a.ts');
    expect(row.querySelector('.git-letter')!.className).toBe('git-letter ');
    action.click();
    expect(opened).toEqual([]);
  });
});

describe("a commit's diff view", () => {
  const commits = [
    gitCommit(1, { refs: ['HEAD -> main', 'origin/main', 'tag: v1'] }),
    gitCommit(2, { parents: ['sha3', 'sha4'] }),
    gitCommit(3, { parents: [] }),
  ];
  const rows = () => [...document.querySelectorAll<HTMLElement>('.git-commit')];

  it('opens titled for the commit, asking for its files', async () => {
    await h.ready(gitState({ commits }));
    rows()[0]!.click();
    expect(h.sentOfType('gitCommit')).toEqual([{ type: 'gitCommit', id: 'ws-a', sha: 'sha1' }]);
    expect($('diff-title').textContent).toBe('Commit 1');
    expect($('diff-meta').textContent).toContain('abc1 · octocat');
    expect($('diff-body').textContent).toBe('Loading…');
    expect($('diff-files').hidden).toBe(true);
    expect(h.toggled).toBe(1);
    // Opening another commit while open keeps the view and does not toggle the panel again.
    rows()[1]!.click();
    expect(h.toggled).toBe(1);
    expect($('diff-title').textContent).toBe('Commit 2');
  });

  it('lists the commit’s files and shows the first one’s diff', async () => {
    await h.ready(gitState({ commits }));
    rows()[0]!.click();
    h.sent.length = 0;
    h.view.setCommit({
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
    expect(h.sentOfType('gitDiff')).toEqual([{ type: 'gitDiff', id: 'ws-a', path: 'a.ts', sha: 'sha1' }]);
    expect(document.querySelector<HTMLElement>('#diff-files .git-file')!.classList.contains('selected')).toBe(true);

    document.querySelectorAll<HTMLElement>('#diff-files .git-file')[1]!.click();
    expect(h.sentOfType('gitDiff')[1]).toEqual({ type: 'gitDiff', id: 'ws-a', path: 'dir/b.ts', sha: 'sha1' });
    expect([...document.querySelectorAll('#diff-files .git-file')].map((row) => row.classList.contains('selected'))).toEqual([false, true]);
  });

  it('says so when a commit changed no files, or could not be read', async () => {
    await h.ready(gitState({ commits }));
    rows()[0]!.click();
    h.view.setCommit({ type: 'gitCommit', id: 'ws-a', sha: 'sha1', error: null, files: [] });
    expect($('diff-body').textContent).toBe('No files changed.');
    expect($('diff-files').hidden).toBe(true);
    h.view.setCommit({ type: 'gitCommit', id: 'ws-a', sha: 'sha1', error: 'bad object', files: [] });
    expect($('diff-body').textContent).toBe('Could not read the commit: bad object');
  });

  it('ignores a commit answer for a commit that is no longer open, or for another workspace', async () => {
    await h.ready(gitState({ commits }));
    rows()[0]!.click();
    h.view.setCommit({ type: 'gitCommit', id: 'ws-a', sha: 'sha2', error: null, files: [{ path: 'x.ts', status: 'M' }] });
    h.view.setCommit({ type: 'gitCommit', id: 'ws-b', sha: 'sha1', error: null, files: [{ path: 'x.ts', status: 'M' }] });
    expect(document.querySelectorAll('#diff-files .git-file')).toHaveLength(0);
  });

  it('ignores a file click once the view has closed', async () => {
    await h.ready(gitState({ commits }));
    rows()[0]!.click();
    h.view.setCommit({ type: 'gitCommit', id: 'ws-a', sha: 'sha1', error: null, files: [{ path: 'a.ts', status: 'M' }] });
    const row = document.querySelector<HTMLElement>('#diff-files .git-file')!;
    h.view.close();
    h.sent.length = 0;
    row.click();
    expect(h.sent).toEqual([]);
  });
});

describe('a diff', () => {
  const open = async () => {
    await h.ready(gitState({ files: [gitFile('a.ts')] }));
    click('.git-file');
  };
  const answer = (diff: string, extra: Partial<Extract<Parameters<GitView['setDiff']>[0], { type: 'gitDiff' }>> = {}) =>
    h.view.setDiff({ type: 'gitDiff', id: 'ws-a', path: 'a.ts', sha: null, diff, truncated: false, error: null, ...extra });
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
  const answer = (value: typeof compare | null, error: string | null = null) => h.view.setCompare({ type: 'gitCompare', id: 'ws-a', compare: value, error });

  it('opens a diff view titled for the branch, and asks for the comparison', async () => {
    await h.ready(gitState({ branch: 'feature/x' }));
    click('.git-chip-btn:not(.ci)');
    expect(h.sentOfType('gitCompare')).toEqual([{ type: 'gitCompare', id: 'ws-a' }]);
    expect($('diff-title').textContent).toBe('feature/x vs main');
    expect($('diff').hidden).toBe(false);
  });

  it('titles the view for a detached HEAD', async () => {
    await h.ready(gitState({ branch: null }));
    click('.git-chip-btn');
    expect($('diff-title').textContent).toBe('This branch vs main');
  });

  it('says how far ahead the branch is, lists the files and shows the first against the base', async () => {
    await h.ready();
    click('.git-chip-btn');
    h.sent.length = 0;
    answer(compare);
    expect($('diff-meta').textContent).toBe('3 commits ahead of origin/main (forked at abc123)');
    expect(text('#diff-files .git-file-name')).toEqual(['a.ts', 'b.ts']);
    expect(h.sentOfType('gitDiff')).toEqual([{ type: 'gitDiff', id: 'ws-a', path: 'a.ts', base: true }]);
    document.querySelectorAll<HTMLElement>('#diff-files .git-file')[1]!.click();
    expect(h.sentOfType('gitDiff')[1]).toEqual({ type: 'gitDiff', id: 'ws-a', path: 'b.ts', base: true });
  });

  it('uses the singular for one commit', async () => {
    await h.ready();
    click('.git-chip-btn');
    answer({ ...compare, ahead: 1 });
    expect($('diff-meta').textContent).toContain('1 commit ahead');
  });

  it('shows the base-relative diff for the selected file', async () => {
    await h.ready();
    click('.git-chip-btn');
    answer(compare);
    h.view.setDiff({ type: 'gitDiff', id: 'ws-a', path: 'a.ts', sha: null, diff: '+added', truncated: false, error: null });
    expect(text('#diff-body .diff-line')).toEqual(['+added']);
  });

  it('says so when nothing differs, or the comparison failed', async () => {
    await h.ready();
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
    await h.ready();
    answer(compare);
    expect($('diff-meta').textContent).toBe('');
    click('.git-chip-btn');
    h.view.setCompare({ type: 'gitCompare', id: 'ws-b', compare, error: null });
    expect($('diff-files').children).toHaveLength(0);
  });

  it('stops comparing once the view closes, or a working-tree file opens instead', async () => {
    await h.ready(gitState({ files: [gitFile('a.ts')] }));
    click('.git-chip-btn');
    click('#diff-close');
    h.sent.length = 0;
    answer(compare);
    expect(h.sent).toEqual([]);

    click('.git-chip-btn');
    click('.git-file');
    h.sent.length = 0;
    answer(compare);
    expect(h.sent).toEqual([]);
  });
});

describe('the ref card', () => {
  const commits = [gitCommit(1, { refs: ['HEAD -> main', 'origin/main', 'tag: v1'] }), gitCommit(2)];
  const rows = () => [...document.querySelectorAll<HTMLElement>('.git-commit')];

  it('lists every ref of a commit while its chips are hovered, and takes it away after', async () => {
    await h.ready(gitState({ commits }));
    const refs = rows()[0]!.querySelector<HTMLElement>('.git-refs')!;
    expect(document.querySelector('.ref-card')).toBeNull();
    refs.dispatchEvent(new MouseEvent('mouseenter'));
    const card = document.querySelector<HTMLElement>('.ref-card')!;
    expect(text('.git-ref', card)).toEqual(['main', 'origin/main', 'tag: v1']);
    expect([...card.querySelectorAll('.git-ref')].map((chip) => chip.className)).toEqual(['git-ref head', 'git-ref', 'git-ref tag']);
    // Entering again replaces the card rather than stacking another.
    refs.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelectorAll('.ref-card')).toHaveLength(1);
    refs.dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.querySelector('.ref-card')).toBeNull();
  });

  it('drops the card when the list is redrawn under the pointer, and for a commit with one ref', async () => {
    await h.ready(gitState({ commits }));
    rows()[0]!.querySelector<HTMLElement>('.git-refs')!.dispatchEvent(new MouseEvent('mouseenter'));
    h.setState(gitState({ commits }));
    expect(document.querySelector('.ref-card')).toBeNull();
    await h.ready(gitState({ commits: [gitCommit(1, { refs: ['origin/x'] })] }));
    rows()[0]!.querySelector<HTMLElement>('.git-refs')!.dispatchEvent(new MouseEvent('mouseenter'));
    expect(document.querySelector('.ref-card')).toBeNull();
  });
});
