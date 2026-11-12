import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectControl, gitRepo, opened, ORIGIN, startHarness, TOKEN, type Harness } from './harness';
import { waitFor } from './wait-for';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

function call(path: string, init: { method?: string; body?: unknown; token?: string | null; origin?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN}`;
  if (init.origin) headers.origin = init.origin;
  return fetch(h.url(path), { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

describe('HTTP API', () => {
  it('requires the bearer token', async () => {
    expect((await call('/workspaces', { token: null })).status).toBe(401);
    expect((await call('/workspaces', { token: 'b'.repeat(64) })).status).toBe(401);
  });

  it('rejects requests from web pages even with the token', async () => {
    expect((await call('/workspaces', { origin: 'https://evil.example' })).status).toBe(403);
  });

  it('accepts requests from the extension origin', async () => {
    expect((await call('/workspaces', { origin: ORIGIN })).status).toBe(200);
  });

  it('creates a workspace in the default directory and asks the extension to open it', async () => {
    const { ws, messages } = connectControl(h);
    await opened(ws);

    const res = await call('/workspaces', { method: 'POST', body: { ticket: 'PROJ-1', url: 'https://jira.example/browse/PROJ-1' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { id: string; name: string; cwd: string }; created: boolean; delivered: boolean };
    expect(body).toMatchObject({ created: true, delivered: true, workspace: { name: 'PROJ-1', cwd: h.defaultCwd } });

    await waitFor(() => messages.some((m) => m.type === 'open' && m.id === body.workspace.id));
    const list = (await (await call('/workspaces')).json()) as { workspaces: { id: string }[] };
    expect(list.workspaces.map((w) => w.id)).toEqual([body.workspace.id]);
    ws.close();
  });

  it('creates a workspace in a fresh worktree, and reports a worktree it could not make', async () => {
    const repoDir = gitRepo();
    const res = await call('/workspaces', { method: 'POST', body: { ticket: 'PROJ-2', cwd: repoDir, worktree: 'PROJ-2' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { cwd: string } };
    expect(body.workspace.cwd).toBe(realpathSync(join(repoDir, '.claude', 'worktrees', 'PROJ-2')));

    const bad = await call('/workspaces', { method: 'POST', body: { ticket: 'PROJ-3', cwd: h.defaultCwd, worktree: 'PROJ-3' } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('worktree');
    const invalid = await call('/workspaces', { method: 'POST', body: { ticket: 'PROJ-4', cwd: repoDir, worktree: '-bad' } });
    expect(invalid.status).toBe(400);
  });

  it('focuses the existing workspace for a ticket instead of creating a duplicate', async () => {
    const existing = h.store.create({ name: 'PROJ-1', ticket: 'PROJ-1', cwd: h.defaultCwd });
    const { ws, messages } = connectControl(h);
    await opened(ws);

    const res = await call('/workspaces', { method: 'POST', body: { ticket: 'proj-1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: false, workspace: { id: existing.id } });
    await waitFor(() => messages.some((m) => m.type === 'focus' && m.id === existing.id));
    expect(h.store.list()).toHaveLength(1);
    ws.close();
  });

  it('rejects a missing or relative working directory', async () => {
    expect((await call('/workspaces', { method: 'POST', body: { name: 'x', cwd: join(h.defaultCwd, 'nope') } })).status).toBe(400);
    expect((await call('/workspaces', { method: 'POST', body: { name: 'x', cwd: 'relative/dir' } })).status).toBe(400);
  });

  it('rejects a workspace with neither name nor ticket, and non-web urls', async () => {
    expect((await call('/workspaces', { method: 'POST', body: {} })).status).toBe(400);
    expect((await call('/workspaces', { method: 'POST', body: { name: 'x', url: 'javascript:alert(1)' } })).status).toBe(400);
  });

  it('reports 409 when focusing with no extension connected, and delivers when one is', async () => {
    const ws1 = h.store.create({ name: 'a', cwd: h.defaultCwd });
    expect((await call(`/workspaces/${ws1.id}/focus`, { method: 'POST' })).status).toBe(409);

    const { ws, messages } = connectControl(h);
    await opened(ws);
    expect((await call(`/workspaces/${ws1.id}/focus`, { method: 'POST' })).status).toBe(200);
    await waitFor(() => messages.some((m) => m.type === 'focus' && m.id === ws1.id));
    ws.close();
  });

  it('pastes text into a running terminal without submitting it, and says when there is none', async () => {
    const running = h.store.create({ name: 'running', cwd: h.defaultCwd });
    const idle = h.store.create({ name: 'idle', cwd: h.defaultCwd });
    const session = h.sessions.create({ id: running.id, command: '/bin/cat', args: [], cwd: h.defaultCwd });
    let output = '';
    session.attach(
      (data) => (output += data),
      () => {},
    );
    const ok = await call(`/workspaces/${running.id}/send`, { method: 'POST', body: { text: 'hello there' } });
    expect(ok.status).toBe(200);
    await waitFor(() => output.includes('hello there'));
    expect(output).not.toContain('hello there\r');
    expect((await call(`/workspaces/${idle.id}/send`, { method: 'POST', body: { text: 'x' } })).status).toBe(409);
    expect((await call(`/workspaces/${running.id}/send`, { method: 'POST', body: { text: '' } })).status).toBe(400);
    expect((await call(`/workspaces/${running.id}/send`, { method: 'POST', body: { text: 'x'.repeat(20_001) } })).status).toBe(400);
    expect((await call('/workspaces/ws-00000000/send', { method: 'POST', body: { text: 'x' } })).status).toBe(404);
  });

  it('404s unknown workspaces and paths', async () => {
    expect((await call('/workspaces/ws-00000000/focus', { method: 'POST' })).status).toBe(404);
    expect((await call('/nope')).status).toBe(404);
  });

  it('deletes a workspace, remembering it under Archived like the panel does', async () => {
    const ws1 = h.store.create({ name: 'a', cwd: h.defaultCwd });
    expect((await call(`/workspaces/${ws1.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(h.store.list()).toEqual([]);
    expect(h.history.list().map((entry) => entry.name)).toEqual(['a']);
  });

  it('focuses the existing PR workspace without making the worktree asked for', async () => {
    const repoDir = gitRepo();
    const pr = 'https://github.com/acme/app/pull/7';
    const existing = h.store.create({ name: 'app#7', pr, cwd: h.defaultCwd });
    const res = await call('/workspaces', { method: 'POST', body: { pr, cwd: repoDir, worktree: 'PROJ-7' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: false, workspace: { id: existing.id } });
    expect(existsSync(join(repoDir, '.claude', 'worktrees', 'PROJ-7'))).toBe(false);
  });

  it('creates a PR workspace with a prompt, and focuses it on a repeat', async () => {
    const pr = 'https://github.com/acme/web-app/pull/482';
    const first = await call('/workspaces', { method: 'POST', body: { pr, prompt: '/code-review' } });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ created: true, workspace: { name: 'web-app#482', pr, url: pr, prompt: '/code-review', cwd: h.defaultCwd } });

    const again = await call('/workspaces', { method: 'POST', body: { pr } });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false });
    expect(h.store.list()).toHaveLength(1);
  });

  it('rejects a non-PR url and an overlong prompt', async () => {
    expect((await call('/workspaces', { method: 'POST', body: { pr: 'https://github.com/o/r/issues/1' } })).status).toBe(400);
    expect((await call('/workspaces', { method: 'POST', body: { name: 'x', prompt: 'x'.repeat(8001) } })).status).toBe(400);
  });
});
