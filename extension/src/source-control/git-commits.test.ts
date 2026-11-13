// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isolateDocumentListeners } from '../../testing/fixtures';
import { GIT_NOW, type GitViewHarness, gitCommit, gitState, mountGitView } from '../../testing/git-fixtures';

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

describe('the commit list', () => {
  const commits = [
    gitCommit(1, { refs: ['HEAD -> main', 'origin/main', 'tag: v1'] }),
    gitCommit(2, { parents: ['sha3', 'sha4'] }),
    gitCommit(3, { parents: [] }),
  ];
  const rows = () => [...document.querySelectorAll<HTMLElement>('.git-commit')];

  it('lists commits with their subject, age and a graph, merges drawn hollow', async () => {
    await h.ready(gitState({ commits }));
    expect(text('#git-commits h3')).toEqual(['Commits3']);
    expect(text('.git-subject')).toEqual(['Commit 1', 'Commit 2', 'Commit 3']);
    expect(text('.git-when')).toEqual(['1h ago', '2h ago', '3h ago']);
    expect(rows()[0]!.querySelector('svg.git-graph')).not.toBeNull();
    expect(rows()[0]!.querySelector('circle')!.getAttribute('fill')).not.toBeNull();
    expect(rows()[1]!.querySelector<SVGElement>('circle')!.style.fill).toBe('var(--list-bg)');
    expect(rows()[0]!.title).toContain('abc1 · octocat');
  });

  it('draws a line for each segment of the graph', async () => {
    await h.ready(gitState({ commits }));
    // Every commit here has a parent below it, so every row carries at least one line, and the merge's second lane makes its graph wider.
    expect(rows().map((row) => row.querySelectorAll('line').length > 0)).toEqual([true, true, true]);
    const width = (row: HTMLElement) => Number(row.querySelector('svg')!.getAttribute('width'));
    expect(width(rows()[1]!)).toBe(width(rows()[0]!));
    expect(width(rows()[0]!)).toBeGreaterThan(12);
  });

  it('shows the first ref by name and folds the rest into a count with the names on hover', async () => {
    await h.ready(gitState({ commits }));
    expect(text('.git-ref', rows()[0]!)).toEqual(['main', '+2']);
    expect(rows()[0]!.querySelector<HTMLElement>('.git-ref.head')).not.toBeNull();
    expect(rows()[0]!.querySelector<HTMLElement>('.git-ref.more')!.getAttribute('aria-label')).toBe('2 more: origin/main, tag: v1');
    expect(rows()[1]!.querySelector('.git-refs')).toBeNull();
  });

  it('tones tags and heads', async () => {
    await h.ready(gitState({ commits: [gitCommit(1, { refs: ['tag: v2'] }), gitCommit(2, { refs: ['HEAD'] }), gitCommit(3, { refs: ['origin/x'] })] }));
    expect(rows().map((row) => row.querySelector('.git-ref')!.className)).toEqual(['git-ref tag', 'git-ref head', 'git-ref']);
  });

  it('shows no commits section when there are none', async () => {
    await h.ready(gitState({ commits: [] }));
    expect($('git-commits').children).toHaveLength(0);
  });

  it("opens a commit's diff view on click", async () => {
    await h.ready(gitState({ commits }));
    rows()[0]!.click();
    expect(h.sentOfType('gitCommit')).toEqual([{ type: 'gitCommit', id: 'ws-a', sha: 'sha1' }]);
    expect($('diff-title').textContent).toBe('Commit 1');
  });
});

describe('switching branch', () => {
  const branches = [
    { name: 'main', current: true, upstream: 'origin/main' },
    { name: 'feature/x', current: false, upstream: null },
  ];
  const menu = () => document.querySelector('.branch-menu') as HTMLElement | null;

  it('asks for the branches and shows a loading menu', async () => {
    await h.ready();
    click('.git-branch-name');
    expect(h.sentOfType('gitBranches')).toEqual([{ type: 'gitBranches', id: 'ws-a' }]);
    expect(menu()!.textContent).toBe('Loading branches…');
  });

  it('lists them, ticking and disabling the current one, and switches on click', async () => {
    await h.ready();
    click('.git-branch-name');
    h.view.setBranches({ type: 'gitBranches', id: 'ws-a', branches, error: null });
    const items = [...menu()!.querySelectorAll<HTMLButtonElement>('button')];
    expect(items.map((item) => item.textContent)).toEqual(['✓ main', 'feature/x']);
    expect(items.map((item) => item.disabled)).toEqual([true, false]);
    expect(items.map((item) => item.title)).toEqual(['main\ntracks origin/main', 'feature/x\nlocal only']);
    items[1]!.click();
    expect(h.sentOfType('gitSwitch')).toEqual([{ type: 'gitSwitch', id: 'ws-a', branch: 'feature/x' }]);
    expect(menu()).toBeNull();
  });

  it('says so when there are no branches', async () => {
    await h.ready();
    click('.git-branch-name');
    h.view.setBranches({ type: 'gitBranches', id: 'ws-a', branches: [], error: null });
    expect(menu()!.textContent).toBe('No branches');
  });

  it('reports an error listing them', async () => {
    await h.ready();
    click('.git-branch-name');
    h.view.setBranches({ type: 'gitBranches', id: 'ws-a', branches: [], error: 'no remote' });
    expect($('git-notice').textContent).toBe('Could not list branches: no remote');
    expect($('git-notice').className).toBe('bad');
  });

  it('does not open a menu nobody asked for, or for another workspace', async () => {
    await h.ready();
    h.view.setBranches({ type: 'gitBranches', id: 'ws-a', branches, error: null });
    expect(menu()).toBeNull();
    click('.git-branch-name');
    h.view.setBranches({ type: 'gitBranches', id: 'ws-b', branches, error: null });
    expect(menu()!.textContent).toBe('Loading branches…');
  });

  it('does nothing without a workspace', () => {
    h.view.setWorkspace(undefined);
    expect(document.querySelector('.git-branch-name')).toBeNull();
    h.view.setBranches({ type: 'gitBranches', id: 'ws-a', branches, error: null });
    expect(menu()).toBeNull();
  });
});
