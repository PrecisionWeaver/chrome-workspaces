// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolateDocumentListeners, makeWorkspace } from '../../testing/fixtures';
import { GIT_NOW, GIT_WORKSPACE, type GitViewHarness, gitCommit, gitFile, gitState, mountGitView } from '../../testing/git-fixtures';

isolateDocumentListeners();

let h: GitViewHarness;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const files = () => [...document.querySelectorAll<HTMLElement>('#git-changes .git-file')];
const tabs = () => [...document.querySelectorAll<HTMLElement>('#diff-tabs .diff-tab')];
const names = () => tabs().map((tab) => tab.querySelector('.diff-tab-name')!.textContent);
const active = () =>
  tabs()
    .find((tab) => tab.classList.contains('active'))
    ?.querySelector('.diff-tab-name')?.textContent;
const open = (index: number) => files()[index]!.click();
const pin = (index: number) => files()[index]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
const diffRequests = () => h.sentOfType('gitDiff').map((message) => message.path);
const threeFiles = () => gitState({ files: [gitFile('a.ts'), gitFile('b.ts'), gitFile('c.ts')] });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(GIT_NOW);
  h = mountGitView();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('opening files in tabs', () => {
  it('shows no strip until a file is opened, then a preview tab for it', async () => {
    await h.ready(threeFiles());
    expect($('diff-tabs').hidden).toBe(true);
    open(0);
    expect($('diff-tabs').hidden).toBe(false);
    expect(names()).toEqual(['a.ts']);
    expect(tabs()[0]!.classList.contains('preview')).toBe(true);
    expect(tabs()[0]!.getAttribute('aria-selected')).toBe('true');
  });

  it('lets the next single click replace a preview tab', async () => {
    await h.ready(threeFiles());
    open(0);
    open(1);
    expect(names()).toEqual(['b.ts']);
    expect(diffRequests()).toEqual(['a.ts', 'b.ts']);
  });

  it('keeps a tab that was double-clicked, and opens the next one beside it', async () => {
    await h.ready(threeFiles());
    open(0);
    pin(0);
    expect(tabs()[0]!.classList.contains('preview')).toBe(false);
    open(1);
    open(2);
    expect(names()).toEqual(['a.ts', 'c.ts']);
    expect(tabs().map((tab) => tab.classList.contains('preview'))).toEqual([false, true]);
  });

  it('keeps a tab that its own double-click pins', async () => {
    await h.ready(threeFiles());
    open(0);
    tabs()[0]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    open(1);
    expect(names()).toEqual(['a.ts', 'b.ts']);
  });

  it('shows the status letter and the path on each tab', async () => {
    await h.ready(gitState({ files: [gitFile('src/a.ts', ' ', 'M'), gitFile('new.ts', '?', '?')] }));
    open(0);
    pin(0);
    open(1);
    expect(tabs().map((tab) => tab.querySelector('.git-letter')!.textContent)).toEqual(['M', 'U']);
    expect(tabs()[0]!.title).toBe('src/a.ts');
  });
});

describe('switching and closing tabs', () => {
  const openThree = async () => {
    await h.ready(threeFiles());
    for (const index of [0, 1, 2]) {
      open(index);
      pin(index);
    }
    h.sent.length = 0;
  };

  it('shows the diff of the tab clicked, without opening another', async () => {
    await openThree();
    tabs()[0]!.click();
    expect(active()).toBe('a.ts');
    expect(names()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect($('diff-title').textContent).toBe('a.ts');
    expect(diffRequests()).toEqual(['a.ts']);
  });

  it('closes a tab with its ×, moving to the one on its right, else on its left', async () => {
    await openThree();
    tabs()[0]!.click();
    (tabs()[0]!.querySelector('.diff-tab-close') as HTMLElement).click();
    expect(names()).toEqual(['b.ts', 'c.ts']);
    expect(active()).toBe('b.ts');
    (tabs()[1]!.querySelector('.diff-tab-close') as HTMLElement).click();
    expect(names()).toEqual(['b.ts']);
    expect(active()).toBe('b.ts');
  });

  it('closes a tab that is not showing without changing what is showing', async () => {
    await openThree();
    (tabs()[0]!.querySelector('.diff-tab-close') as HTMLElement).click();
    expect(names()).toEqual(['b.ts', 'c.ts']);
    expect(active()).toBe('c.ts');
    expect(diffRequests()).toEqual([]);
  });

  it('closes on a middle click', async () => {
    await openThree();
    tabs()[1]!.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    expect(names()).toEqual(['a.ts', 'c.ts']);
  });

  it('closes the diff view with its last tab', async () => {
    await h.ready(threeFiles());
    open(0);
    const toggled = h.toggled;
    (tabs()[0]!.querySelector('.diff-tab-close') as HTMLElement).click();
    expect(tabs()).toHaveLength(0);
    expect(h.view.isOpen).toBe(false);
    expect($('diff').hidden).toBe(true);
    expect(h.toggled).toBe(toggled + 1);
  });

  it('moves between tabs with the arrow keys, keeping focus on the tab shown', async () => {
    await openThree();
    tabs()[1]!.click();
    tabs()[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(active()).toBe('c.ts');
    expect(document.activeElement).toBe(tabs()[2]);
    tabs()[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(active()).toBe('c.ts');
    tabs()[2]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(active()).toBe('b.ts');
  });
});

describe('the tabs beside other views', () => {
  it('hides the strip while a commit is open and brings it back with the next file', async () => {
    await h.ready(gitState({ files: [gitFile('a.ts')], commits: [gitCommit(1)] }));
    open(0);
    pin(0);
    document.querySelector<HTMLElement>('.git-commit')!.click();
    expect($('diff-tabs').hidden).toBe(true);
    open(0);
    expect($('diff-tabs').hidden).toBe(false);
    expect(names()).toEqual(['a.ts']);
  });

  it('keeps each workspace’s tabs, and brings them back on returning', async () => {
    await h.ready(threeFiles());
    open(0);
    pin(0);
    h.view.setWorkspace(makeWorkspace({ id: 'ws-b' }));
    expect($('diff-tabs').hidden).toBe(true);
    expect(tabs()).toHaveLength(0);
    h.view.setWorkspace(GIT_WORKSPACE);
    h.setState(threeFiles());
    open(1);
    expect(names()).toEqual(['a.ts', 'b.ts']);
  });

  it('keeps its tabs when the diff view is closed and opened again', async () => {
    await h.ready(threeFiles());
    open(0);
    pin(0);
    document.getElementById('diff-close')!.click();
    expect($('diff-tabs').hidden).toBe(true);
    open(1);
    expect(names()).toEqual(['a.ts', 'b.ts']);
  });
});

describe('keeping the diff in step with the working tree', () => {
  it('asks again for the diff showing when its file changes', async () => {
    await h.ready(threeFiles());
    open(0);
    h.sent.length = 0;
    h.setState(gitState({ files: [gitFile('a.ts', 'M', ' '), gitFile('b.ts'), gitFile('c.ts')] }));
    expect(diffRequests()).toEqual(['a.ts']);
    h.setState(gitState({ files: [gitFile('a.ts', 'M', ' '), gitFile('b.ts'), gitFile('c.ts')] }));
    expect(diffRequests()).toEqual(['a.ts']);
  });

  it('does not ask again for a change to another file', async () => {
    await h.ready(threeFiles());
    open(0);
    h.sent.length = 0;
    h.setState(gitState({ files: [gitFile('a.ts'), gitFile('b.ts', 'M', ' '), gitFile('c.ts')] }));
    expect(diffRequests()).toEqual([]);
  });

  it('says so, and dims the tab, when the file no longer differs from HEAD', async () => {
    await h.ready(threeFiles());
    open(0);
    pin(0);
    h.setState(gitState({ files: [gitFile('b.ts'), gitFile('c.ts')] }));
    expect($('diff-body').textContent).toBe('No changes: this file now matches HEAD.');
    expect(tabs()[0]!.classList.contains('clean')).toBe(true);
    expect(tabs()[0]!.title).toBe('a.ts (no changes)');
  });
});
