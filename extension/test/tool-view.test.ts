// @vitest-environment happy-dom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MONITOR_SESSION, SHELL_SESSION } from '../../shared/protocol';
import { loadPanelHtml } from './fixtures';

/** xterm needs a real browser, so a recording stand-in takes its place; what matters here is how the view drives it. */
const terms: FakeTerminal[] = [];
class FakeTerminal {
  cols = 80;
  rows = 24;
  options: { theme?: unknown } = {};
  written: string[] = [];
  opened: HTMLElement | null = null;
  resets = 0;
  focused = 0;
  onDataListener: ((data: string) => void) | null = null;
  pendingWrite: (() => void) | null = null;
  constructor() {
    terms.push(this);
  }
  loadAddon() {}
  open(element: HTMLElement) {
    this.opened = element;
  }
  reset() {
    this.resets++;
  }
  focus() {
    this.focused++;
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
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
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
vi.mock('../src/helper-client', () => ({
  getHelper: vi.fn(() => (helperResult === 'ok' ? Promise.resolve({ token: 't', port: 1 }) : Promise.reject(new Error('down')))),
  openSocket: vi.fn((_helper: unknown, path: string) => new FakeSocket(path)),
}));

let resizeCallback: () => void;
let observed: Element[];

beforeEach(() => {
  terms.length = 0;
  FakeSocket.instances = [];
  observed = [];
  helperResult = 'ok';
  fits.mockClear();
  loadPanelHtml();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallback = callback;
      }
      observe(element: Element) {
        observed.push(element);
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function make() {
  const { createToolView } = await import('../src/tool-view');
  const onToggle = vi.fn();
  const view = createToolView({ onToggle });
  return { view, onToggle, term: terms.at(-1)! };
}
const socket = () => FakeSocket.instances.at(-1)!;

describe('showing', () => {
  it('opens the section, titled for the tool, and tells the panel', async () => {
    const { view, onToggle } = await make();
    expect(view.isOpen).toBe(false);
    view.show('monitor');
    expect(view.isOpen).toBe(true);
    expect(view.current).toBe('monitor');
    expect($('tool').hidden).toBe(false);
    expect($('tool-title').textContent).toBe('System monitor');
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('opens the terminal in its holder once, when first shown, so xterm can measure it', async () => {
    const { view, term } = await make();
    expect(term.opened).toBeNull();
    view.show('shell');
    expect(term.opened).toBe($('tool-terminal'));
    view.show('monitor');
    view.close();
    view.show('shell');
    expect(terms).toHaveLength(1);
  });

  it('attaches to the tool’s own helper session', async () => {
    const { view } = await make();
    view.show('monitor');
    await flush();
    expect(socket().path).toBe(`/attach?session=${MONITOR_SESSION}`);
    view.show('shell');
    await flush();
    expect(socket().path).toBe(`/attach?session=${SHELL_SESSION}`);
  });

  it('does nothing when the tool is already showing', async () => {
    const { view, onToggle } = await make();
    view.show('shell');
    view.show('shell');
    await flush();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('switches to the other tool without telling the panel again, dropping the first connection and clearing the screen', async () => {
    const { view, onToggle, term } = await make();
    view.show('monitor');
    await flush();
    const first = socket();
    view.show('shell');
    await flush();
    expect(first.closed).toBe(true);
    expect(socket()).not.toBe(first);
    expect(term.resets).toBe(2);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect($('tool-title').textContent).toBe('Terminal');
  });
});

describe('closing', () => {
  it('hides the section, drops the connection and tells the panel, from the view or its close button', async () => {
    const { view, onToggle } = await make();
    view.show('shell');
    await flush();
    $('tool-close').click();
    expect(view.isOpen).toBe(false);
    expect(view.current).toBeNull();
    expect($('tool').hidden).toBe(true);
    expect(socket().closed).toBe(true);
    expect(onToggle).toHaveBeenCalledTimes(2);

    view.close();
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('does not connect if closed before the helper answered', async () => {
    const { view } = await make();
    view.show('shell');
    view.close();
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it('does not connect a tool that was switched away from before the helper answered', async () => {
    const { view } = await make();
    view.show('monitor');
    view.show('shell');
    await flush();
    expect(FakeSocket.instances.map((s) => s.path)).toEqual([`/attach?session=${SHELL_SESSION}`]);
  });
});

describe('the connection', () => {
  it('fits the terminal and sends its size, and focuses it, once open', async () => {
    const { view, term } = await make();
    view.show('shell');
    await flush();
    socket().onopen!();
    expect(JSON.parse(socket().sent[0]!)).toEqual({ type: 'resize', cols: 80, rows: 24 });
    expect(term.focused).toBe(1);
  });

  it('resizes the terminal as its holder changes, only while a tool is showing', async () => {
    const { view } = await make();
    expect(observed).toEqual([$('tool-terminal')]);
    resizeCallback();
    expect(fits).not.toHaveBeenCalled();

    view.show('shell');
    await flush();
    fits.mockClear();
    resizeCallback();
    expect(fits).toHaveBeenCalledTimes(1);
    expect(socket().sent.map((s) => JSON.parse(s).type)).toContain('resize');
  });

  it('sends what is typed, but not the replies xterm makes to replayed output', async () => {
    const { view, term } = await make();
    view.show('shell');
    await flush();
    term.onDataListener!('ls\r');
    expect(socket().sent.map((s) => JSON.parse(s))).toContainEqual({ type: 'input', data: 'ls\r' });

    socket().receive({ type: 'output', data: 'old screen', replay: true });
    term.onDataListener!('\x1b[?1;2c');
    expect(socket().sent.filter((s) => JSON.parse(s).type === 'input')).toHaveLength(1);

    term.pendingWrite!();
    term.onDataListener!('next');
    expect(socket().sent.filter((s) => JSON.parse(s).type === 'input')).toHaveLength(2);
  });

  it('writes live output straight to the terminal', async () => {
    const { view, term } = await make();
    view.show('shell');
    await flush();
    socket().receive({ type: 'output', data: 'hello', replay: false });
    expect(term.written).toEqual(['hello']);
    // A live write does not hold typing back.
    term.onDataListener!('x');
    expect(socket().sent.filter((s) => JSON.parse(s).type === 'input')).toHaveLength(1);
  });

  it('does not send input while not connected', async () => {
    const { view, term } = await make();
    view.show('shell');
    await flush();
    socket().readyState = 3;
    term.onDataListener!('x');
    expect(socket().sent).toEqual([]);
  });

  it('goes back to the workspace when the program quits or the shell exits', async () => {
    const { view, onToggle } = await make();
    view.show('monitor');
    await flush();
    socket().receive({ type: 'exit' });
    expect(view.isOpen).toBe(false);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('says so in the terminal when the helper drops the connection, but not when the view closed it', async () => {
    const { view, term } = await make();
    view.show('shell');
    await flush();
    socket().onclose!();
    expect(term.written.join('')).toContain('[disconnected from helper]');

    view.show('monitor');
    await flush();
    const mine = socket();
    term.written.length = 0;
    view.close();
    mine.onclose!();
    expect(term.written).toEqual([]);
  });

  it('says so when the helper cannot be reached, if that tool is still showing', async () => {
    helperResult = 'fail';
    const { view, term } = await make();
    view.show('shell');
    await flush();
    expect(term.written.join('')).toContain('[could not reach the helper]');

    term.written.length = 0;
    view.show('monitor');
    view.close();
    await flush();
    expect(term.written).toEqual([]);
  });
});

describe('theme', () => {
  it('passes the theme to the terminal', async () => {
    const { view, term } = await make();
    view.setTheme({ background: '#fff' });
    expect(term.options.theme).toEqual({ background: '#fff' });
  });
});
