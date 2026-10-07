import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectControl, opened, ORIGIN, startHarness, TOKEN, type Harness } from './harness';
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

    const res = await call('/workspaces', { method: 'POST', body: { ticket: 'ORC-1', url: 'https://jira.example/browse/ORC-1' } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { workspace: { id: string; name: string; cwd: string }; created: boolean; delivered: boolean };
    expect(body).toMatchObject({ created: true, delivered: true, workspace: { name: 'ORC-1', cwd: h.defaultCwd } });

    await waitFor(() => messages.some((m) => m.type === 'open' && m.id === body.workspace.id));
    const list = (await (await call('/workspaces')).json()) as { workspaces: { id: string }[] };
    expect(list.workspaces.map((w) => w.id)).toEqual([body.workspace.id]);
    ws.close();
  });

  it('focuses the existing workspace for a ticket instead of creating a duplicate', async () => {
    const existing = h.store.create({ name: 'ORC-1', ticket: 'ORC-1', cwd: h.defaultCwd });
    const { ws, messages } = connectControl(h);
    await opened(ws);

    const res = await call('/workspaces', { method: 'POST', body: { ticket: 'orc-1' } });
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

  it('404s unknown workspaces and paths', async () => {
    expect((await call('/workspaces/ws-00000000/focus', { method: 'POST' })).status).toBe(404);
    expect((await call('/nope')).status).toBe(404);
  });

  it('deletes a workspace', async () => {
    const ws1 = h.store.create({ name: 'a', cwd: h.defaultCwd });
    expect((await call(`/workspaces/${ws1.id}`, { method: 'DELETE' })).status).toBe(200);
    expect(h.store.list()).toEqual([]);
  });
});
