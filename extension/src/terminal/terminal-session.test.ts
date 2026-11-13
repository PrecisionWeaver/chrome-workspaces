// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol/protocol';
import { installChrome } from '../../testing/chrome-mock';
import type { SessionHandlers } from './terminal-session';

/** xterm needs a real browser, so a recording stand-in takes its place; what matters here is how the module drives it. */
const terms: FakeTerminal[] = [];
class FakeTerminal {
  cols = 80;
  rows = 24;
  written: string[] = [];
  addons: unknown[] = [];
  onDataListener: ((data: string) => void) | null = null;
  pendingWrite: (() => void) | null = null;
  constructor(readonly options: unknown) {
    terms.push(this);
  }
  loadAddon(addon: unknown) {
    this.addons.push(addon);
  }
  onData(listener: (data: string) => void) {
    this.onDataListener = listener;
  }
  write(data: string, callback?: () => void) {
    this.written.push(data);
    // A write's callback fires once xterm has processed it; the test releases it.
    this.pendingWrite = callback ?? null;
  }
}
const fits = vi.fn();
let linkHandler: ((event: unknown, uri: string) => void) | null = null;
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(handler: (event: unknown, uri: string) => void) {
      linkHandler = handler;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = fits;
  },
}));

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly path: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
let helperResult: 'ok' | 'fail' = 'ok';
vi.mock('../app/helper-client', () => ({
  getHelper: vi.fn(() => (helperResult === 'ok' ? Promise.resolve({ token: 't', port: 1 }) : Promise.reject(new Error('down')))),
  openSocket: vi.fn((_helper: unknown, path: string) => new FakeSocket(path)),
}));

// Loaded after the mocks above are in place: a static import would be hoisted above the fakes it needs.
const { connectSession, createSessionTerminal, shiftEnterNewline } = await import('./terminal-session');

let fake: ReturnType<typeof installChrome>;
let sent: ClientMessage[];
const send = (message: ClientMessage) => void sent.push(message);
const term = () => terms[0]!;
const socket = () => FakeSocket.instances.at(-1)!;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  fake = installChrome();
  fake.addWindow();
  vi.stubGlobal('WebSocket', FakeSocket);
  terms.length = 0;
  FakeSocket.instances = [];
  fits.mockClear();
  linkHandler = null;
  helperResult = 'ok';
  sent = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createSessionTerminal', () => {
  it('sends what is typed as input', () => {
    createSessionTerminal(send);
    term().onDataListener!('ls\r');
    expect(sent).toEqual([{ type: 'input', data: 'ls\r' }]);
  });

  it('writes output straight to the terminal', () => {
    const terminal = createSessionTerminal(send);
    terminal.output({ type: 'output', data: 'hello' });
    expect(term().written).toEqual(['hello']);
    expect(term().pendingWrite).toBeNull();
  });

  it('drops the terminal’s replies while replayed scrollback is being parsed, so the shell does not read them as typing', () => {
    const terminal = createSessionTerminal(send);
    terminal.output({ type: 'output', data: '\x1b[c', replay: true });
    term().onDataListener!('\x1b[?1;2c');
    expect(sent).toEqual([]);
    term().pendingWrite!();
    term().onDataListener!('y');
    expect(sent).toEqual([{ type: 'input', data: 'y' }]);
  });

  it('fits itself to its box and tells the session its new size', () => {
    const terminal = createSessionTerminal(send);
    term().cols = 100;
    term().rows = 30;
    terminal.refit();
    expect(fits).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([{ type: 'resize', cols: 100, rows: 30 }]);
    expect(terminal.term).toBe(term());
  });

  it('opens a link clicked in the terminal in a tab of its own, since a side panel cannot open windows', async () => {
    createSessionTerminal(send);
    expect(term().addons).toHaveLength(2);
    linkHandler!({}, 'https://example.com/docs');
    await flush();
    expect(fake.mock.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/docs' });
  });
});

describe('shiftEnterNewline', () => {
  const event = (init: KeyboardEventInit & { type?: string }) => new KeyboardEvent(init.type ?? 'keydown', { key: 'Enter', ...init });

  it('sends ESC + CR for Shift+Enter on the way down, and keeps xterm out of it', () => {
    expect(shiftEnterNewline(event({ shiftKey: true }), send)).toBe(false);
    expect(sent).toEqual([{ type: 'input', data: '\x1b\r' }]);
  });

  it('swallows the key up too, without sending twice', () => {
    expect(shiftEnterNewline(event({ shiftKey: true, type: 'keyup' }), send)).toBe(false);
    expect(sent).toEqual([]);
  });

  it('leaves plain Enter, other keys, and Shift+Enter with another modifier to xterm', () => {
    expect(shiftEnterNewline(event({}), send)).toBe(true);
    expect(shiftEnterNewline(event({ key: 'a', shiftKey: true }), send)).toBe(true);
    expect(shiftEnterNewline(event({ shiftKey: true, ctrlKey: true }), send)).toBe(true);
    expect(shiftEnterNewline(event({ shiftKey: true, altKey: true }), send)).toBe(true);
    expect(shiftEnterNewline(event({ shiftKey: true, metaKey: true }), send)).toBe(true);
    expect(sent).toEqual([]);
  });
});

describe('connectSession', () => {
  let handlers: SessionHandlers & { messages: ServerMessage[] };
  beforeEach(() => {
    handlers = {
      messages: [],
      onOpen: vi.fn(),
      onMessage: vi.fn((message: ServerMessage) => void handlers.messages.push(message)),
      onDisconnect: vi.fn(),
      onUnreachable: vi.fn(),
    };
  });

  it('attaches to the session once the helper’s address is known, and says when it is open', async () => {
    const terminal = createSessionTerminal(send);
    const link = connectSession('ws-00000001', terminal, handlers);
    expect(FakeSocket.instances).toHaveLength(0);
    expect(link.send({ type: 'input', data: 'x' })).toBe(false);
    await flush();
    expect(socket().path).toBe('/attach?session=ws-00000001');
    socket().onopen!();
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    expect(link.send({ type: 'input', data: 'x' })).toBe(true);
    expect(socket().sent).toEqual([JSON.stringify({ type: 'input', data: 'x' })]);
  });

  it('writes output to the terminal and hands every other message to the view', async () => {
    const terminal = createSessionTerminal(send);
    connectSession('ws-00000001', terminal, handlers);
    await flush();
    socket().receive({ type: 'output', data: 'hi' });
    socket().receive({ type: 'exit', code: 0 });
    expect(term().written).toEqual(['hi']);
    expect(handlers.messages).toEqual([{ type: 'exit', code: 0 }]);
  });

  it('reports a dropped connection, but not one it closed itself', async () => {
    const terminal = createSessionTerminal(send);
    const link = connectSession('ws-00000001', terminal, handlers);
    await flush();
    socket().onclose!();
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
    expect(link.send({ type: 'input', data: 'x' })).toBe(false);

    const again = connectSession('ws-00000001', terminal, handlers);
    await flush();
    again.close();
    expect(socket().closed).toBe(true);
    socket().onclose!();
    expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
    expect(again.send({ type: 'input', data: 'x' })).toBe(false);
  });

  it('does not send on a socket that is not open yet', async () => {
    const terminal = createSessionTerminal(send);
    const link = connectSession('ws-00000001', terminal, handlers);
    await flush();
    socket().readyState = 0;
    expect(link.send({ type: 'input', data: 'x' })).toBe(false);
    expect(socket().sent).toEqual([]);
  });

  it('never opens a socket for a link closed, or a view moved on, before the address arrived', async () => {
    const terminal = createSessionTerminal(send);
    connectSession('ws-00000001', terminal, handlers).close();
    connectSession('ws-00000002', terminal, { ...handlers, isCurrent: () => false });
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    connectSession('ws-00000003', terminal, { ...handlers, isCurrent: () => true });
    await flush();
    expect(socket().path).toBe('/attach?session=ws-00000003');
  });

  it('says when the helper cannot be reached, unless the link was closed meanwhile', async () => {
    helperResult = 'fail';
    const terminal = createSessionTerminal(send);
    connectSession('ws-00000001', terminal, handlers);
    await flush();
    expect(handlers.onUnreachable).toHaveBeenCalledTimes(1);
    connectSession('ws-00000001', terminal, handlers).close();
    await flush();
    expect(handlers.onUnreachable).toHaveBeenCalledTimes(1);
  });
});
