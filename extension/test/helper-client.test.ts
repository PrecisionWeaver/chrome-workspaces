import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_HOST_NAME, PROTOCOL, TOKEN_PROTOCOL_PREFIX, type ControlToClient } from '../../shared/protocol';
import { connectControl, getHelper, openSocket, startHelper } from '../src/helper-client';
import { installChrome } from './chrome-mock';

class FakeSocket {
  static readonly OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(message: ControlToClient | { type: 'ping' }) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

let fake: ReturnType<typeof installChrome>;
const flush = () => vi.advanceTimersByTimeAsync(0);
const last = () => FakeSocket.instances.at(-1)!;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  fake = installChrome();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('getHelper and startHelper', () => {
  it("asks the native host for the helper's token and port", async () => {
    fake.mock.runtime.sendNativeMessage.mockResolvedValue({ ok: true, token: 'abc', port: 4321 });
    await expect(getHelper()).resolves.toEqual({ token: 'abc', port: 4321 });
    expect(fake.mock.runtime.sendNativeMessage).toHaveBeenCalledWith(NATIVE_HOST_NAME, { type: 'hello' });
  });

  it("throws the host's error", async () => {
    fake.mock.runtime.sendNativeMessage.mockResolvedValue({ ok: false, error: 'helper not installed' });
    await expect(getHelper()).rejects.toThrow('helper not installed');
    await expect(startHelper()).rejects.toThrow('helper not installed');
  });

  it('asks the host to start the agent', async () => {
    fake.mock.runtime.sendNativeMessage.mockResolvedValue({ ok: true });
    await startHelper();
    expect(fake.mock.runtime.sendNativeMessage).toHaveBeenCalledWith(NATIVE_HOST_NAME, { type: 'start' });
  });
});

describe('openSocket', () => {
  it('connects to localhost, carrying the token in the subprotocol rather than the url', () => {
    const socket = openSocket({ token: 'abc', port: 4321 }, '/control') as unknown as FakeSocket;
    expect(socket.url).toBe('ws://127.0.0.1:4321/control');
    expect(socket.protocols).toEqual([PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}abc`]);
  });
});

describe('connectControl', () => {
  it('reports connected on open, delivers parsed messages, and sends only while open', async () => {
    const messages: ControlToClient[] = [];
    const changes: boolean[] = [];
    const control = connectControl(
      (message) => messages.push(message),
      (connected) => changes.push(connected),
    );
    await flush();

    expect(control.send({ type: 'refreshReviews' })).toBe(false);
    expect(control.connected).toBe(false);

    last().open();
    expect(changes).toEqual([true]);
    expect(control.connected).toBe(true);
    expect(control.send({ type: 'refreshReviews' })).toBe(true);
    expect(last().sent).toEqual(['{"type":"refreshReviews"}']);

    last().receive({ type: 'focus', id: 'ws-a' });
    expect(messages).toEqual([{ type: 'focus', id: 'ws-a' }]);
  });

  it('pings every 20 seconds while open, to keep the service worker alive', async () => {
    connectControl(() => {});
    await flush();
    last().open();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(last().sent).toEqual(Array(3).fill('{"type":"ping"}'));
  });

  it('stops pinging once the socket closes', async () => {
    connectControl(() => {});
    await flush();
    const socket = last();
    socket.open();
    socket.drop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(socket.sent).toEqual([]);
  });

  it('reconnects after a close, starting at one second and doubling up to thirty', async () => {
    const changes: boolean[] = [];
    connectControl(
      () => {},
      (connected) => changes.push(connected),
    );
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);

    const waits: number[] = [];
    for (let attempt = 0; attempt < 7; attempt++) {
      const before = FakeSocket.instances.length;
      last().drop();
      let waited = 0;
      while (FakeSocket.instances.length === before) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      waits.push(waited);
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(changes.every((connected) => !connected)).toBe(true);
  });

  it('starts over at one second once a connection opens', async () => {
    connectControl(() => {});
    await flush();
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    last().drop();
    await vi.advanceTimersByTimeAsync(2000);
    last().open();
    last().drop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(4);
  });

  it('retries while the helper is unreachable, and says it is not connected', async () => {
    fake.mock.runtime.sendNativeMessage.mockRejectedValueOnce(new Error('Specified native messaging host not found.'));
    const changes: boolean[] = [];
    connectControl(
      () => {},
      (connected) => changes.push(connected),
    );
    await flush();
    expect(changes).toEqual([false]);
    expect(FakeSocket.instances).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('ignores the close of a socket that has been replaced', async () => {
    const control = connectControl(() => {});
    await flush();
    const first = last();
    first.open();
    first.drop();
    await vi.advanceTimersByTimeAsync(1000);
    last().open();
    first.onclose?.();
    expect(control.connected).toBe(true);
  });
});
