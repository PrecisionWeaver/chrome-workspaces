import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient, ReviewRequest } from '../../shared/protocol';
import { connectControl, opened, startHarness, type Harness } from './harness';
import { waitFor } from './wait-for';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

function lastState(messages: ControlToClient[]) {
  const states = messages.filter((m) => m.type === 'state');
  return states[states.length - 1];
}

const PR = 'https://github.com/acme/web-app/pull/482';
const review: ReviewRequest = {
  repo: 'acme/web-app',
  number: 482,
  title: 'PROJ-9 - x',
  url: PR,
  author: 'drew',
  isDraft: false,
  updatedAt: '2026-10-01T00:00:00Z',
  ticket: 'PROJ-9',
  merge: 'unknown',
  mergeReason: null,
};

describe('control channel', () => {
  it('sends the current state on connect', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    h.statuses[a.id] = 'needs_input';
    const { ws, messages } = connectControl(h);
    await waitFor(() => messages.length > 0);
    expect(messages[0]).toEqual({
      type: 'state',
      workspaces: [expect.objectContaining({ id: a.id })],
      statuses: { [a.id]: 'needs_input' },
      reviews: { items: [], error: null, fetchedAt: null },
    });
    ws.close();
  });

  it('pairs windows and records tabs, broadcasting the new state', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const { ws, messages } = connectControl(h);
    await opened(ws);

    ws.send(JSON.stringify({ type: 'pair', id: a.id, windowId: 7 }));
    ws.send(JSON.stringify({ type: 'tabs', windowId: 7, urls: ['https://x/1'] }));
    await waitFor(() => {
      const state = lastState(messages);
      return state?.type === 'state' && state.workspaces[0]?.lastTabUrls[0] === 'https://x/1';
    });
    expect(h.store.get(a.id)).toMatchObject({ windowId: 7, lastTabUrls: ['https://x/1'] });

    ws.send(JSON.stringify({ type: 'unpair', windowId: 7 }));
    await waitFor(() => h.store.get(a.id)?.windowId === null);
    ws.close();
  });

  it('creates a workspace in the current window when asked from an unpaired panel', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'scratch', windowId: 9 }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0]).toMatchObject({ name: 'scratch', windowId: 9, cwd: h.defaultCwd });
    ws.close();
  });

  it('opens a new window for a workspace created without one', async () => {
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'scratch', windowId: null }));
    await waitFor(() => messages.some((m) => m.type === 'open'));
    ws.close();
  });

  it('removes a workspace and ends its terminal session', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const session = h.sessions.create({ id: a.id, command: '/bin/cat', args: [], cwd: h.defaultCwd });
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'remove', id: a.id }));
    await waitFor(() => h.store.list().length === 0);
    await waitFor(() => session.exited);
    expect(h.sessions.get(a.id)).toBeUndefined();
    ws.close();
  });

  it('renames a workspace, trimming the name and ignoring blank or overlong ones', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'rename', id: a.id, name: '   ' }));
    ws.send(JSON.stringify({ type: 'rename', id: a.id, name: 'x'.repeat(81) }));
    ws.send(JSON.stringify({ type: 'rename', id: 'ws-unknown0', name: 'nope' }));
    ws.send(JSON.stringify({ type: 'rename', id: a.id, name: '  Checkout bug  ' }));
    await waitFor(() => h.store.get(a.id)?.name === 'Checkout bug');
    ws.close();
  });

  it('moves a workspace, ignoring unknown ids and bad indexes', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((name) => h.store.create({ name, cwd: h.defaultCwd }));
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'move', id: a.id, index: -1 }));
    ws.send(JSON.stringify({ type: 'move', id: a.id, index: 1.5 }));
    ws.send(JSON.stringify({ type: 'move', id: 'ws-unknown0', index: 0 }));
    ws.send(JSON.stringify({ type: 'move', id: c.id, index: 0 }));
    await waitFor(() => h.store.list()[0]?.id === c.id);
    expect(h.store.list().map((w) => w.id)).toEqual([c.id, a.id, b.id]);
    ws.close();
  });

  it('ignores malformed messages without dropping the connection', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'pair', id: a.id, windowId: 'seven' }));
    ws.send(JSON.stringify({ type: 'pair', id: 'ws-unknown0', windowId: 1 }));
    ws.send(JSON.stringify({ type: 'pair', id: a.id, windowId: 3 }));
    await waitFor(() => h.store.get(a.id)?.windowId === 3);
    ws.close();
  });

  it('creates a PR workspace in its repo directory with the prompt, and opens it', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'cw-repo-'));
    h.reviews.push(review);
    h.repoDirs['acme/web-app'] = repoDir;
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'web-app#482', windowId: null, pr: PR, prompt: `  /code-review ${PR}  ` }));
    await waitFor(() => messages.some((m) => m.type === 'open'));
    expect(h.store.list()[0]).toMatchObject({ name: 'web-app#482', ticket: 'PROJ-9', cwd: repoDir, url: PR, pr: PR, prompt: `/code-review ${PR}` });
    ws.close();
  });

  it('focuses the existing workspace for a PR instead of creating another', async () => {
    const existing = h.store.create({ name: 'mine', cwd: h.defaultCwd, pr: PR });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'web-app#482', windowId: null, pr: PR, prompt: 'x' }));
    await waitFor(() => messages.some((m) => m.type === 'focus' && m.id === existing.id));
    expect(h.store.list()).toHaveLength(1);
    ws.close();
  });

  it('creates a prompt-only workspace in the default directory', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'triage', windowId: null, prompt: 'Dig into this prod issue' }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0]).toMatchObject({ name: 'triage', cwd: h.defaultCwd, pr: null, prompt: 'Dig into this prod issue' });
    ws.close();
  });

  it('ignores a create with a non-PR url or an overlong prompt', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'a', windowId: null, pr: 'https://evil.example/o/r/pull/1' }));
    ws.send(JSON.stringify({ type: 'create', name: 'b', windowId: null, prompt: 'x'.repeat(8001) }));
    ws.send(JSON.stringify({ type: 'create', name: 'c', windowId: null }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0].name).toBe('c');
    ws.close();
  });

  it('asks for a tab group when a workspace joins a window, and records the pairing the extension reports', async () => {
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'a', windowId: 9 }));
    ws.send(JSON.stringify({ type: 'create', name: 'b', windowId: 9, group: true }));
    await waitFor(() => h.store.list().length === 2);
    const [a, b] = h.store.list();
    expect([a.windowId, b.windowId]).toEqual([9, 9]);
    await waitFor(() => messages.some((m) => m.type === 'group'));
    expect(messages.filter((m) => m.type === 'group')).toEqual([{ type: 'group', id: b.id }]);

    ws.send(JSON.stringify({ type: 'pair', id: b.id, windowId: 9, groupId: 44 }));
    await waitFor(() => h.store.get(b.id)?.groupId === 44);
    ws.send(JSON.stringify({ type: 'unpairGroup', groupId: 44 }));
    await waitFor(() => h.store.get(b.id)?.groupId === null);
    expect(h.store.get(b.id)?.windowId).toBe(9);
    ws.close();
  });

  it('starts a workspace with the tabs it was given, and ignores a request with a bad one', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'bad', windowId: null, urls: ['https://a.example', 'javascript:alert(1)'] }));
    ws.send(JSON.stringify({ type: 'create', name: 'many', windowId: null, urls: Array.from({ length: 21 }, (_, i) => `https://x.example/${i}`) }));
    ws.send(JSON.stringify({ type: 'create', name: 'ok', windowId: null, urls: ['https://a.example', 'http://b.example/path?q=1'] }));
    await waitFor(() => h.store.list().length >= 1);
    expect(h.store.list().map((w) => [w.name, w.lastTabUrls])).toEqual([['ok', ['https://a.example', 'http://b.example/path?q=1']]]);
    ws.close();
  });

  it('rejects a model that is not a plain id', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'bad', windowId: null, model: "x'; rm -rf ~" }));
    ws.send(JSON.stringify({ type: 'create', name: 'ok', windowId: null, model: 'sonnet' }));
    await waitFor(() => h.store.list().length >= 1);
    expect(h.store.list().map((w) => w.name)).toEqual(['ok']);
    ws.close();
  });

  it('starts a PR workspace in the directory picked, else its repo\'s configured one', async () => {
    const picked = mkdtempSync(join(tmpdir(), 'cw-pick-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'cw-repo-'));
    h.repoDirs['acme/web-app'] = repoDir;
    h.reviews.push(review);
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'web-app#482', windowId: null, pr: PR, cwd: picked }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0].cwd).toBe(picked);
    h.store.remove(h.store.list()[0].id);
    ws.send(JSON.stringify({ type: 'create', name: 'web-app#482', windowId: null, pr: PR }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0].cwd).toBe(repoDir);
    ws.close();
  });

  it('answers git requests for a workspace\'s directory, to the asking client only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-ctl-git-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'f.txt'), 'x\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    writeFileSync(join(dir, 'f.txt'), 'x\ny\n');
    const workspace = h.store.create({ name: 'g', cwd: dir });
    const plain = h.store.create({ name: 'plain', cwd: mkdtempSync(join(tmpdir(), 'cw-ctl-nogit-')) });

    const asker = connectControl(h);
    const other = connectControl(h);
    await Promise.all([opened(asker.ws), opened(other.ws)]);
    asker.ws.send(JSON.stringify({ type: 'git', id: workspace.id }));
    asker.ws.send(JSON.stringify({ type: 'git', id: plain.id }));
    asker.ws.send(JSON.stringify({ type: 'git', id: 'ws-00000000' }));
    asker.ws.send(JSON.stringify({ type: 'gitDiff', id: workspace.id, path: 'f.txt' }));
    asker.ws.send(JSON.stringify({ type: 'gitDiff', id: workspace.id, path: '../x' }));
    asker.ws.send(JSON.stringify({ type: 'gitCommit', id: workspace.id, sha: '--output=x' }));
    await waitFor(() => asker.messages.filter((m) => m.type === 'git' || m.type === 'gitDiff').length === 5);

    const replies = asker.messages.filter((m) => m.type === 'git' || m.type === 'gitDiff');
    const stateReply = replies.find((m) => m.type === 'git' && m.id === workspace.id);
    expect(stateReply).toMatchObject({ state: { branch: 'main', files: [{ path: 'f.txt', worktree: 'M' }], commits: [{ subject: 'init' }] }, error: null });
    expect(replies.find((m) => m.type === 'git' && m.id === plain.id)).toMatchObject({ state: null, error: expect.any(String) });
    expect(replies.find((m) => m.type === 'git' && m.id === 'ws-00000000')).toMatchObject({ state: null, error: 'unknown workspace' });
    expect(replies.find((m) => m.type === 'gitDiff' && m.path === 'f.txt')).toMatchObject({ diff: expect.stringContaining('+y'), error: null });
    expect(replies.find((m) => m.type === 'gitDiff' && m.path === '../x')).toMatchObject({ diff: '', error: expect.stringContaining('path') });
    // A malformed commit id is dropped before it reaches git.
    expect(asker.messages.some((m) => m.type === 'gitCommit')).toBe(false);
    expect(other.messages.some((m) => m.type === 'git' || m.type === 'gitDiff')).toBe(false);
    asker.ws.close();
    other.ws.close();
  });

  it('shows the worktree claude has moved into, but only one of the workspace\'s own repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-wt-main-'));
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd });
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'f.txt'), 'x\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    const tree = join(mkdtempSync(join(tmpdir(), 'cw-wt-')), 'feature-tree');
    git(dir, 'worktree', 'add', '-q', '-b', 'feature', tree);
    const stranger = mkdtempSync(join(tmpdir(), 'cw-other-'));
    git(stranger, 'init', '-q', '-b', 'elsewhere');
    const workspace = h.store.create({ name: 'w', cwd: dir });

    const { ws, messages } = connectControl(h);
    await opened(ws);
    const branchAfter = async (n: number) => {
      await waitFor(() => messages.filter((m) => m.type === 'git').length === n);
      const reply = messages.filter((m) => m.type === 'git')[n - 1];
      return reply.type === 'git' ? reply.state?.branch : undefined;
    };

    ws.send(JSON.stringify({ type: 'git', id: workspace.id }));
    expect(await branchAfter(1)).toBe('main');
    h.workingDirs[workspace.id] = tree;
    ws.send(JSON.stringify({ type: 'git', id: workspace.id }));
    expect(await branchAfter(2)).toBe('feature');
    // A directory outside the repository, or one that does not exist, is ignored.
    h.workingDirs[workspace.id] = stranger;
    ws.send(JSON.stringify({ type: 'git', id: workspace.id }));
    expect(await branchAfter(3)).toBe('main');
    h.workingDirs[workspace.id] = '/no/such/dir';
    ws.send(JSON.stringify({ type: 'git', id: workspace.id }));
    expect(await branchAfter(4)).toBe('main');
    ws.close();
  });

  it('reorders the whole list in one step, and ignores an order that is not the current workspaces', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((name) => h.store.create({ name, cwd: h.defaultCwd }));
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'order', ids: [b.id, a.id] }));
    ws.send(JSON.stringify({ type: 'order', ids: [c.id, a.id, b.id] }));
    await waitFor(() => h.store.list()[0].id === c.id);
    expect(h.store.list().map((w) => w.name)).toEqual(['c', 'a', 'b']);
    ws.close();
  });

  it('answers listRepos to the asking client only', async () => {
    h.repos.push({ name: 'chrome-workspaces', path: '/w/chrome-workspaces', root: 'Websites' });
    const asker = connectControl(h);
    const other = connectControl(h);
    await Promise.all([opened(asker.ws), opened(other.ws)]);
    asker.ws.send(JSON.stringify({ type: 'listRepos' }));
    await waitFor(() => asker.messages.some((m) => m.type === 'repos'));
    expect(asker.messages.find((m) => m.type === 'repos')).toEqual({ type: 'repos', repos: h.repos });
    expect(other.messages.some((m) => m.type === 'repos')).toBe(false);
    asker.ws.close();
    other.ws.close();
  });

  it('starts a workspace in the given directory, falling back to the default when it is not one', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cw-repo-'));
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'here', windowId: null, cwd: repo }));
    ws.send(JSON.stringify({ type: 'create', name: 'bad', windowId: null, cwd: '/no/such/dir' }));
    ws.send(JSON.stringify({ type: 'create', name: 'relative', windowId: null, cwd: 'repo' }));
    await waitFor(() => h.store.list().length === 3);
    expect(h.store.list().map((w) => [w.name, w.cwd])).toEqual([
      ['here', repo],
      ['bad', h.defaultCwd],
      ['relative', h.defaultCwd],
    ]);
    ws.close();
  });

  it('answers listPrompts to the asking client only, reporting read errors', async () => {
    h.prompts.push({ section: 'Reviews', text: '/code-review PR-URL' });
    const asker = connectControl(h);
    const other = connectControl(h);
    await Promise.all([opened(asker.ws), opened(other.ws)]);
    asker.ws.send(JSON.stringify({ type: 'listPrompts' }));
    await waitFor(() => asker.messages.some((m) => m.type === 'prompts'));
    expect(asker.messages.find((m) => m.type === 'prompts')).toEqual({ type: 'prompts', prompts: [{ section: 'Reviews', text: '/code-review PR-URL' }], error: null });

    h.promptsError = 'cannot read /x.md: ENOENT';
    asker.ws.send(JSON.stringify({ type: 'listPrompts' }));
    await waitFor(() => asker.messages.filter((m) => m.type === 'prompts').length === 2);
    expect(asker.messages.filter((m) => m.type === 'prompts')[1]).toEqual({ type: 'prompts', prompts: [], error: 'cannot read /x.md: ENOENT' });
    expect(other.messages.some((m) => m.type === 'prompts')).toBe(false);
    asker.ws.close();
    other.ws.close();
  });

  it('refreshes review requests on request', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'refreshReviews' }));
    await waitFor(() => h.reviewRefreshes === 1);
    ws.close();
  });

  it('answers prDetails to the asking client, reporting fetch errors and ignoring non-PR urls', async () => {
    h.prDetailsJson = JSON.stringify({ number: 482, title: 't', url: PR, author: { login: 'drew' }, headRefName: 'h', baseRefName: 'b', isDraft: false, additions: 1, deletions: 2, changedFiles: 3, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', createdAt: 'c', updatedAt: 'u', latestReviews: [], reviewRequests: [], statusCheckRollup: [] });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'prDetails', url: 'https://evil.example/o/r/pull/1' }));
    ws.send(JSON.stringify({ type: 'prDetails', url: PR }));
    await waitFor(() => messages.some((m) => m.type === 'prDetails'));
    expect(messages.filter((m) => m.type === 'prDetails')).toEqual([
      { type: 'prDetails', url: PR, details: expect.objectContaining({ title: 't', reviewDecision: 'APPROVED' }), error: null },
    ]);
    expect(h.prDetailsRequests).toEqual([PR]);

    h.prDetailsJson = null;
    ws.send(JSON.stringify({ type: 'prDetails', url: PR }));
    await waitFor(() => messages.filter((m) => m.type === 'prDetails').length === 2);
    expect(messages.filter((m) => m.type === 'prDetails')[1]).toEqual({ type: 'prDetails', url: PR, details: null, error: 'gh failed' });
    ws.close();
  });
});
