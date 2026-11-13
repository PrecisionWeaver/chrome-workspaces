// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlToClient } from '../../shared/protocol/protocol';
import { installChrome } from '../testing/chrome-mock';
import { makeWorkspace } from '../testing/fixtures';

/** xterm needs a real browser, so a recording stand-in takes its place; what matters here is how the page drives it. */
const terms: FakeTerminal[] = [];
class FakeTerminal {
  cols = 80;
  rows = 24;
  options: { theme?: unknown } = {};
  written: string[] = [];
  resets = 0;
  focused = 0;
  onDataListener: ((data: string) => void) | null = null;
  keyHandler: ((event: Partial<KeyboardEvent>) => boolean) | null = null;
  pendingWrite: (() => void) | null = null;
  constructor() {
    terms.push(this);
  }
  loadAddon() {}
  open() {}
  reset() {
    this.resets++;
  }
  focus() {
    this.focused++;
  }
  onData(listener: (data: string) => void) {
    this.onDataListener = listener;
  }
  attachCustomKeyEventHandler(handler: (event: Partial<KeyboardEvent>) => boolean) {
    this.keyHandler = handler;
  }
  write(data: string, callback?: () => void) {
    this.written.push(data);
    this.pendingWrite = callback ?? null;
  }
}
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();
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
let onControl: (message: ControlToClient) => void = () => {};
vi.mock('./app/helper-client', () => ({
  getHelper: vi.fn(() => (helperResult === 'ok' ? Promise.resolve({ token: 't', port: 1 }) : Promise.reject(new Error('down')))),
  openSocket: vi.fn((_helper: unknown, path: string) => new FakeSocket(path)),
  connectControl: vi.fn((handler: (message: ControlToClient) => void) => {
    onControl = handler;
    return { send: () => true, connected: true };
  }),
}));

let resizeCallback: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  terms.length = 0;
  FakeSocket.instances = [];
  helperResult = 'ok';
  installChrome();
  document.body.innerHTML = '<header id="bar"><span id="status"></span><span id="name"></span></header><div id="terminal"></div>';
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallback = callback;
      }
      observe() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener: () => {} }));
  vi.spyOn(window, 'close').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const $ = (id: string) => document.getElementById(id)!;
const socket = () => FakeSocket.instances.at(-1)!;
const flush = () => vi.advanceTimersByTimeAsync(0);

async function open(search = '?ws=ws-one') {
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`chrome-extension://ext-id/popout.html${search}`);
  await import('./popout');
  await flush();
  return terms.at(-1)!;
}
const state = (workspaces = [makeWorkspace({ id: 'ws-one', name: 'acme/app' })], statuses = {}) =>
  onControl({ type: 'state', workspaces, statuses, waiting: {}, reviews: { items: [], error: null, updatedAt: null } } as unknown as ControlToClient);

describe('attaching', () => {
  it('attaches to the workspace named in the address and fits the terminal on open', async () => {
    const term = await open();
    expect(socket().path).toBe('/attach?session=ws-one');
    socket().onopen?.();
    expect(term.resets).toBe(1);
    expect(term.focused).toBe(1);
    expect(JSON.parse(socket().sent.at(-1)!)).toEqual({ type: 'resize', cols: 80, rows: 24 });
  });

  it('sends typing as input, but drops what xterm answers while replayed output is parsed', async () => {
    const term = await open();
    term.onDataListener?.('ls');
    socket().receive({ type: 'output', data: 'old', replay: true });
    term.onDataListener?.('1;2c');
    term.pendingWrite?.();
    term.onDataListener?.('pwd');
    socket().receive({ type: 'output', data: 'new' });
    expect(socket().sent.map((line) => JSON.parse(line))).toEqual([
      { type: 'input', data: 'ls' },
      { type: 'input', data: 'pwd' },
    ]);
    expect(term.written).toEqual(['old', 'new']);
  });

  it('sends Shift+Enter as escape and return, and leaves other keys to xterm', async () => {
    const term = await open();
    expect(term.keyHandler?.({ key: 'Enter', shiftKey: true, type: 'keydown' })).toBe(false);
    expect(term.keyHandler?.({ key: 'a', shiftKey: true, type: 'keydown' })).toBe(true);
    expect(JSON.parse(socket().sent.at(-1)!)).toEqual({ type: 'input', data: '\x1b\r' });
  });

  it('sends a resize when the window is resized or focused', async () => {
    await open();
    resizeCallback();
    window.dispatchEvent(new Event('focus'));
    expect(socket().sent.map((line) => JSON.parse(line).type)).toEqual(['resize', 'resize']);
  });

  it('reattaches after the helper connection drops, and after the helper cannot be reached', async () => {
    const term = await open();
    const first = socket();
    first.onclose?.();
    expect(term.written.at(-1)).toContain('reconnecting');
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket()).not.toBe(first);

    helperResult = 'fail';
    socket().onclose?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(term.written.at(-1)).toContain('could not reach the helper');
    const count = FakeSocket.instances.length;
    helperResult = 'ok';
    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeSocket.instances.length).toBe(count + 1);
  });
});

describe('the bar', () => {
  it('shows the workspace name and status, and follows the page title', async () => {
    await open();
    state(undefined, { 'ws-one': 'working' });
    expect($('name').textContent).toBe('acme/app');
    expect(document.title).toBe('acme/app');
    expect($('status').dataset.status).toBe('working');
    state(undefined, {});
    expect($('status').dataset.status).toBeUndefined();
  });

  it('applies the saved theme', async () => {
    await open();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('closing', () => {
  it('says so and closes the window when the workspace leaves the list', async () => {
    const term = await open();
    const attached = socket();
    state([makeWorkspace({ id: 'other' })]);
    expect(term.written.at(-1)).toContain('Workspace closed');
    expect(attached.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1500);
    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it('closes when the session exits, once', async () => {
    await open();
    socket().receive({ type: 'exit', code: 0 });
    state([]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(window.close).toHaveBeenCalledTimes(1);
  });

  it('does not attach when the address names no workspace', async () => {
    const term = await open('');
    expect($('name').textContent).toBe('No workspace');
    expect(FakeSocket.instances).toHaveLength(0);
    expect(term.written.join('')).toContain('not opened for a workspace');
  });
});
