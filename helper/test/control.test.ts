import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient } from '../../shared/protocol';
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

describe('control channel', () => {
  it('sends the current state on connect', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    h.statuses[a.id] = 'needs_input';
    const { ws, messages } = connectControl(h);
    await waitFor(() => messages.length > 0);
    expect(messages[0]).toEqual({ type: 'state', workspaces: [expect.objectContaining({ id: a.id })], statuses: { [a.id]: 'needs_input' } });
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
});
