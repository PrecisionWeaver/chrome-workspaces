import { mkdtempSync } from 'node:fs';
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

const PR = 'https://github.com/vorys-econtrol/pec-platform/pull/482';
const review: ReviewRequest = {
  repo: 'vorys-econtrol/pec-platform',
  number: 482,
  title: 'ORC-9 - x',
  url: PR,
  author: 'drew',
  isDraft: false,
  updatedAt: '2026-10-01T00:00:00Z',
  ticket: 'ORC-9',
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
    h.repoDirs['vorys-econtrol/pec-platform'] = repoDir;
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'pec-platform#482', windowId: null, pr: PR, prompt: `  /code-review ${PR}  ` }));
    await waitFor(() => messages.some((m) => m.type === 'open'));
    expect(h.store.list()[0]).toMatchObject({ name: 'pec-platform#482', ticket: 'ORC-9', cwd: repoDir, url: PR, pr: PR, prompt: `/code-review ${PR}` });
    ws.close();
  });

  it('focuses the existing workspace for a PR instead of creating another', async () => {
    const existing = h.store.create({ name: 'mine', cwd: h.defaultCwd, pr: PR });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'pec-platform#482', windowId: null, pr: PR, prompt: 'x' }));
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
});
