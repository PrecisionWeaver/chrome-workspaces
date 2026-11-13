// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolateDocumentListeners, makeWorkspace } from '../../testing/fixtures';
import { GIT_NOW, type GitViewHarness, gitFile, gitState, mountGitView } from '../../testing/git-fixtures';
import { stagedFiles } from './git-changes';

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

describe('stagedFiles', () => {
  it('picks the files in the index, leaving untracked ones out, and is empty without a state', () => {
    expect(stagedFiles(null)).toEqual([]);
    const files = [gitFile('a.ts', 'M', ' '), gitFile('b.ts', ' ', 'M'), gitFile('c.ts', 'A', 'M'), gitFile('e.ts', '?', '?')];
    expect(stagedFiles(gitState({ files })).map((f) => f.path)).toEqual(['a.ts', 'c.ts']);
  });
});

describe('changes', () => {
  it('splits staged from unstaged, with counts and status letters', async () => {
    await h.ready(
      gitState({
        files: [gitFile('a.ts', 'M', ' '), gitFile('b.ts', ' ', 'M'), gitFile('c.ts', 'A', 'M'), gitFile('d.ts', ' ', 'D'), gitFile('e.ts', '?', '?')],
      }),
    );
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
    await h.ready(gitState({ files: [gitFile('src/deep/new.ts', 'R', ' ', 'src/old.ts'), gitFile('top.ts')] }));
    const rows = [...document.querySelectorAll<HTMLElement>('.git-file')];
    expect(text('.git-file-name', rows[0]!)).toEqual(['new.ts']);
    expect(text('.git-file-dir', rows[0]!)).toEqual(['src/deep']);
    expect(rows[0]!.title).toBe('src/old.ts → src/deep/new.ts');
    expect(text('.git-file-dir', rows[1]!)).toEqual(['']);
    expect(rows[1]!.title).toBe('top.ts');
  });

  it('says the tree is clean when nothing changed, and shows no commit box', async () => {
    await h.ready(gitState({ files: [] }));
    expect(text('.git-empty')).toEqual(['Working tree clean']);
    expect($('git-save').hidden).toBe(true);
  });

  it('shows nothing until git has answered', () => {
    h.view.setWorkspace(makeWorkspace({ id: 'ws-a' }));
    expect($('git-changes').children).toHaveLength(0);
  });

  it('stages and unstages one file or all of them', async () => {
    await h.ready(gitState({ files: [gitFile('a.ts', 'M', ' '), gitFile('b.ts', ' ', 'M')] }));
    const [unstageAll, stageAll] = [...document.querySelectorAll<HTMLElement>('.git-bulk .git-act')];
    unstageAll!.click();
    stageAll!.click();
    click('.git-file:nth-of-type(1) .git-act[title="Unstage"]');
    click('.git-file .git-act[title="Stage"]');
    expect(h.sentOfType('gitStage')).toEqual([
      { type: 'gitStage', id: 'ws-a', paths: [], stage: false },
      { type: 'gitStage', id: 'ws-a', paths: [], stage: true },
      { type: 'gitStage', id: 'ws-a', paths: ['a.ts'], stage: false },
      { type: 'gitStage', id: 'ws-a', paths: ['b.ts'], stage: true },
    ]);
  });

  it('asks twice before discarding, and disarms after three seconds', async () => {
    await h.ready(gitState({ files: [gitFile('b.ts', ' ', 'M')] }));
    const discard = () => document.querySelector<HTMLButtonElement>('.git-act[title="Discard changes"]')!;
    discard().click();
    expect(discard().textContent).toBe('Discard?');
    expect(discard().classList.contains('armed')).toBe(true);
    expect(h.sentOfType('gitDiscard')).toEqual([]);
    // Disarming redraws the list, so the button is looked up again.
    vi.advanceTimersByTime(3000);
    expect(discard().textContent).toBe('↶');
    discard().click();
    expect(h.sentOfType('gitDiscard')).toEqual([]);
    discard().click();
    expect(h.sentOfType('gitDiscard')).toEqual([{ type: 'gitDiscard', id: 'ws-a', paths: ['b.ts'] }]);
  });

  it('keeps a discard armed through the next poll, so the second click still lands', async () => {
    const files = [gitFile('b.ts', ' ', 'M')];
    await h.ready(gitState({ files }));
    const discard = () => document.querySelector<HTMLButtonElement>('.git-act[title="Discard changes"]')!;
    discard().click();
    // The five-second poll answers and redraws the list between the two clicks.
    h.setState(gitState({ files }));
    expect(discard().textContent).toBe('Discard?');
    discard().click();
    expect(h.sentOfType('gitDiscard')).toEqual([{ type: 'gitDiscard', id: 'ws-a', paths: ['b.ts'] }]);
  });

  it('words the discard for an untracked file as a delete', async () => {
    await h.ready(gitState({ files: [gitFile('new.ts', '?', '?')] }));
    const discard = document.querySelector<HTMLButtonElement>('.git-act[title="Delete this new file"]')!;
    discard.click();
    expect(discard.textContent).toBe('Delete?');
    discard.click();
    expect(h.sentOfType('gitDiscard')).toEqual([{ type: 'gitDiscard', id: 'ws-a', paths: ['new.ts'] }]);
  });

  it('does not open the diff when an action button is clicked', async () => {
    await h.ready(gitState({ files: [gitFile('b.ts')] }));
    click('.git-act[title="Stage"]');
    expect(h.sentOfType('gitDiff')).toEqual([]);
  });

  it('highlights files that changed since the last answer, for five seconds', async () => {
    await h.ready(gitState({ files: [gitFile('a.ts')] }));
    expect(document.querySelectorAll('.git-file.fresh')).toHaveLength(0);

    h.setState(gitState({ files: [gitFile('a.ts'), gitFile('b.ts')] }));
    expect(text('.git-file.fresh .git-file-name')).toEqual(['b.ts']);
    h.setState(gitState({ files: [gitFile('a.ts', ' ', 'D'), gitFile('b.ts')] }));
    expect(text('.git-file.fresh .git-file-name').sort()).toEqual(['a.ts', 'b.ts']);

    vi.advanceTimersByTime(5000);
    expect(document.querySelectorAll('.git-file.fresh')).toHaveLength(0);
  });

  it('opens the working-tree diff for a file, by click or Enter', async () => {
    await h.ready(gitState({ files: [gitFile('a.ts')] }));
    const row = document.querySelector<HTMLElement>('.git-file')!;
    row.click();
    expect(h.sentOfType('gitDiff')).toEqual([{ type: 'gitDiff', id: 'ws-a', path: 'a.ts' }]);
    expect($('diff-title').textContent).toBe('a.ts');
    expect($('diff-meta').textContent).toBe('Working tree against HEAD');
    expect($('diff').hidden).toBe(false);
    expect(h.toggled).toBe(1);

    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(h.sentOfType('gitDiff')).toHaveLength(2);
    expect(h.toggled).toBe(1);
  });
});

describe('saving', () => {
  const stagedState = gitState({ files: [gitFile('a.ts', 'M', ' ')] });
  const message = () => $<HTMLTextAreaElement>('git-message');
  const typeMessage = (value: string) => {
    message().value = value;
    message().dispatchEvent(new Event('input'));
  };

  it('shows the commit box once something is staged, with the button waiting for a message', async () => {
    await h.ready(stagedState);
    expect($('git-save').hidden).toBe(false);
    expect($<HTMLButtonElement>('git-save-btn').disabled).toBe(true);
    expect($('git-save-btn').title).toBe('Commit 1 staged file');
    typeMessage('Fix it');
    expect($<HTMLButtonElement>('git-save-btn').disabled).toBe(false);
    typeMessage('   ');
    expect($<HTMLButtonElement>('git-save-btn').disabled).toBe(true);
  });

  it('counts the staged files in the button title', async () => {
    await h.ready(gitState({ files: [gitFile('a.ts', 'M', ' '), gitFile('b.ts', 'A', ' ')] }));
    expect($('git-save-btn').title).toBe('Commit 2 staged files');
  });

  it('keeps the box once a message is started, but disables the button with nothing staged', async () => {
    await h.ready(gitState({ files: [gitFile('a.ts', ' ', 'M')] }));
    expect($('git-save').hidden).toBe(true);
    typeMessage('Half written');
    expect($('git-save').hidden).toBe(false);
    expect($<HTMLButtonElement>('git-save-btn').disabled).toBe(true);
    expect($('git-save-btn').title).toBe('Stage something first');
  });

  it('commits the message, and disables the button while it works', async () => {
    await h.ready(stagedState);
    typeMessage('Fix it');
    click('#git-save-btn');
    expect(h.sentOfType('gitSave')).toEqual([{ type: 'gitSave', id: 'ws-a', message: 'Fix it' }]);
    expect($<HTMLButtonElement>('git-save-btn').disabled).toBe(true);
    click('#git-save-btn');
    expect(h.sentOfType('gitSave')).toHaveLength(1);
  });

  it('commits on Cmd+Enter or Ctrl+Enter, and leaves a plain Enter for a new line', async () => {
    await h.ready(stagedState);
    typeMessage('Fix it');
    const plain = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    message().dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(h.sentOfType('gitSave')).toEqual([]);

    const meta = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, cancelable: true });
    message().dispatchEvent(meta);
    expect(meta.defaultPrevented).toBe(true);
    expect(h.sentOfType('gitSave')).toHaveLength(1);
  });

  it('does not commit an empty message by keyboard', async () => {
    await h.ready(stagedState);
    message().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    expect(h.sentOfType('gitSave')).toEqual([]);
  });

  it('clears the message after a commit, but not after another action, and refreshes at once', async () => {
    await h.ready(stagedState);
    typeMessage('Fix it');
    h.view.setResult({ type: 'gitResult', id: 'ws-a', action: 'stage', ok: true, message: 'Staged' });
    expect(message().value).toBe('Fix it');
    h.setState(stagedState);
    h.view.setResult({ type: 'gitResult', id: 'ws-a', action: 'commit', ok: true, message: 'Committed' });
    expect(message().value).toBe('');
    expect(h.sentOfType('git').length).toBeGreaterThan(0);
  });

  it('re-enables the button after a failed commit', async () => {
    await h.ready(stagedState);
    typeMessage('Fix it');
    click('#git-save-btn');
    h.view.setResult({ type: 'gitResult', id: 'ws-a', action: 'commit', ok: false, message: 'hook failed' });
    expect($<HTMLButtonElement>('git-save-btn').disabled).toBe(false);
  });

  it('forgets a half-written message when the workspace changes', async () => {
    await h.ready(stagedState);
    typeMessage('Half');
    h.view.setWorkspace(makeWorkspace({ id: 'ws-b' }));
    expect(message().value).toBe('');
  });
});
