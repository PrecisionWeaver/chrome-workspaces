import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocketClient from 'ws';
import type { ControlToClient } from '../../../shared/protocol/protocol';
import { ORIGIN, startHarness, TOKEN, type Harness } from '../../../helper/testing/harness';
import { waitFor } from '../../../helper/testing/wait-for';
import { installChrome } from '../../testing/chrome-mock';
import { connectControl, openSocket } from './helper-client';

// The panel's real connection code against a real helper: the two sides otherwise only meet in the shared types.

/** The browser's WebSocket, which a page cannot give an Origin to, and Chrome sets to the extension's own. */
class ExtensionSocket extends WebSocketClient {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols, { origin: ORIGIN });
  }
}

let h: Harness;
let fake: ReturnType<typeof installChrome>;

beforeEach(async () => {
  h = await startHarness();
  fake = installChrome();
  fake.mock.runtime.sendNativeMessage.mockResolvedValue({ ok: true, token: TOKEN, port: h.server.port });
  vi.stubGlobal('WebSocket', ExtensionSocket);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await h.close();
});

describe('helper-client against a running helper', () => {
  it('connects, receives the state, and has its messages understood and answered', async () => {
    const received: ControlToClient[] = [];
    const connected: boolean[] = [];
    const connection = connectControl(
      (message) => received.push(message),
      (value) => connected.push(value),
    );
    await waitFor(() => connection.connected);
    expect(connected).toContain(true);
    expect(received.map((m) => m.type)).toEqual(expect.arrayContaining(['state', 'history']));

    // A message the helper validates and acts on comes back as new state.
    expect(connection.send({ type: 'create', name: 'from-the-panel', windowId: null, prompt: 'hi' })).toBe(true);
    await waitFor(() => received.some((m) => m.type === 'open'));
    await waitFor(() => h.store.list().some((w) => w.name === 'from-the-panel'));

    // One the validator refuses is dropped without closing the connection.
    expect(connection.send({ type: 'pair', id: 'x', windowId: -1 })).toBe(true);
    expect(connection.send({ type: 'rename', id: h.store.list()[0].id, name: 'renamed' })).toBe(true);
    await waitFor(() => h.store.list()[0].name === 'renamed');
    expect(connection.connected).toBe(true);
  });

  it('is refused when the token is wrong', async () => {
    fake.mock.runtime.sendNativeMessage.mockResolvedValue({ ok: true, token: 'b'.repeat(64), port: h.server.port });
    const socket = openSocket({ token: 'b'.repeat(64), port: h.server.port }, '/control');
    const outcome = await new Promise<string>((resolve) => {
      socket.onopen = () => resolve('open');
      socket.onerror = () => resolve('refused');
    });
    expect(outcome).toBe('refused');
  });
});
