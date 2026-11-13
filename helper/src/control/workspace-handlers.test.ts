import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReviewRequest } from '../../../shared/protocol/protocol';
import { connectControl, gitRepo, opened, startHarness, type Harness } from '../../testing/harness';
import { waitFor } from '../../testing/wait-for';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

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
  branch: 'feature/x',
  merge: 'unknown',
  mergeReason: null,
  needsReReview: false,
  approved: false,
  ci: null,
};

// Restore and forget are covered with the archive they act on, in store/history.test.ts.
describe('workspace requests over the control channel', () => {
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

  it('answers a create the store could not save with an error, and keeps serving the channel', async () => {
    const { ws, messages } = connectControl(h);
    await opened(ws);
    // A read-only data folder makes every save fail.
    chmodSync(h.dataDir, 0o555);
    try {
      ws.send(JSON.stringify({ type: 'create', name: 'doomed', windowId: null }));
      await waitFor(() => messages.some((m) => m.type === 'createError'));
      const error = messages.find((m) => m.type === 'createError');
      expect(error).toMatchObject({ type: 'createError', name: 'doomed' });
    } finally {
      chmodSync(h.dataDir, 0o755);
    }
    ws.send(JSON.stringify({ type: 'create', name: 'fine', windowId: null }));
    await waitFor(() => h.store.list().length === 1);
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

  it('starts a workspace in a fresh worktree when asked, or says why it could not', async () => {
    const repoDir = gitRepo();
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'PROJ-7', windowId: null, cwd: repoDir, worktree: 'PROJ-7' }));
    await waitFor(() => messages.some((m) => m.type === 'open'));
    expect(h.store.list()[0]).toMatchObject({ name: 'PROJ-7', cwd: realpathSync(join(repoDir, '.claude', 'worktrees', 'PROJ-7')) });

    ws.send(JSON.stringify({ type: 'create', name: 'again', windowId: null, cwd: h.defaultCwd, worktree: 'again' }));
    await waitFor(() => messages.some((m) => m.type === 'createError'));
    expect(messages.find((m) => m.type === 'createError')).toMatchObject({ name: 'again', message: expect.stringContaining('again') });
    expect(h.store.list()).toHaveLength(1);
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

  it('asks for a tab group when a workspace joins a window another one holds', async () => {
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'a', windowId: 9 }));
    ws.send(JSON.stringify({ type: 'create', name: 'b', windowId: 9, group: true }));
    await waitFor(() => h.store.list().length === 2);
    const [a, b] = h.store.list();
    expect([a.windowId, b.windowId]).toEqual([9, 9]);
    await waitFor(() => messages.some((m) => m.type === 'group'));
    expect(messages.filter((m) => m.type === 'group')).toEqual([{ type: 'group', id: b.id }]);
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

  it("starts a PR workspace in the directory picked, else its repo's configured one", async () => {
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

  it('marks a workspace, and drops a mark with a color that is not one of ours', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const b = h.store.create({ name: 'b', cwd: h.defaultCwd });
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'mark', id: b.id, color: 'hotpink' }));
    ws.send(JSON.stringify({ type: 'mark', id: b.id, pinned: 'yes' }));
    ws.send(JSON.stringify({ type: 'mark', id: b.id, pinned: true, color: 'green' }));
    ws.send(JSON.stringify({ type: 'mark', id: a.id, archived: true }));
    await waitFor(() => h.store.get(b.id)?.pinned === true);
    expect(h.store.list().map((w) => [w.name, w.pinned, w.color])).toEqual([
      ['b', true, 'green'],
      ['a', false, null],
    ]);
    ws.close();
  });

  it('creates a workspace in the color asked for, and ignores one that is not ours', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'tinted', windowId: null, color: 'pink' }));
    ws.send(JSON.stringify({ type: 'create', name: 'bad', windowId: null, color: 'hotpink' }));
    await waitFor(() => h.store.list().length >= 1);
    expect(h.store.list().map((w) => [w.name, w.color])).toEqual([['tinted', 'pink']]);
    ws.close();
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
});
