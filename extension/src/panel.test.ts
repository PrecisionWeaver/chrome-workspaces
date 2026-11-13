// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientMessage,
  ControlToClient,
  ControlToHelper,
  HistoryEntry,
  ReviewsState,
  WaitingOn,
  Workspace,
  WorkspaceStatus,
} from '../../shared/protocol/protocol';
import { installChrome } from '../testing/chrome-mock';
import { isolateDocumentListeners, loadPanelHtml, makeHistoryEntry, makeReview, makeSnapshot, makeWorkspace } from '../testing/fixtures';

isolateDocumentListeners();

/** xterm needs a real browser; a recording stand-in takes its place. */
const terms: FakeTerminal[] = [];
class FakeTerminal {
  cols = 80;
  rows = 24;
  options: { theme?: { background?: string } } = {};
  written: string[] = [];
  pasted: string[] = [];
  resets = 0;
  onDataListener: ((data: string) => void) | null = null;
  keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  pendingWrite: (() => void) | null = null;
  constructor() {
    terms.push(this);
  }
  loadAddon() {}
  open() {}
  reset() {
    this.resets++;
  }
  focus() {}
  paste(text: string) {
    this.pasted.push(text);
  }
  onData(listener: (data: string) => void) {
    this.onDataListener = listener;
  }
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }
  write(data: string, callback?: () => void) {
    this.written.push(data);
    this.pendingWrite = callback ?? null;
  }
}
vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }));
/** Link clicks and searches go to stand-ins that record what they were asked. */
const linkHandlers: ((event: MouseEvent, uri: string) => void)[] = [];
vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    constructor(handler: (event: MouseEvent, uri: string) => void) {
      linkHandlers.push(handler);
    }
  },
}));
class FakeSearch {
  static instances: FakeSearch[] = [];
  findNext = vi.fn(() => true);
  findPrevious = vi.fn(() => true);
  clearDecorations = vi.fn();
  constructor() {
    FakeSearch.instances.push(this);
  }
}
vi.mock('@xterm/addon-search', () => ({ SearchAddon: FakeSearch }));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}));

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 1;
  sent: ClientMessage[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly path: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  receive(message: object) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let onControlMessage: (message: ControlToClient) => void;
let onConnected: (connected: boolean) => void;
let sent: ControlToHelper[];
const startHelper = vi.fn(async () => {});
let helperUp = true;
vi.mock('./app/helper-client', () => ({
  connectControl: (onMessage: (message: ControlToClient) => void, onConnectedChange: (connected: boolean) => void) => {
    onControlMessage = onMessage;
    onConnected = onConnectedChange;
    return { send: (message: ControlToHelper) => (sent.push(message), true), connected: true };
  },
  getHelper: vi.fn(() => (helperUp ? Promise.resolve({ token: 't', port: 1 }) : Promise.reject(new Error('down')))),
  openSocket: vi.fn((_helper: unknown, path: string) => new FakeSocket(path)),
  startHelper: () => startHelper(),
  isHostMissing: (error: unknown) => /native messaging host not found/i.test(String(error)),
}));

let fake: ReturnType<typeof installChrome>;
let windowId: number;

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const REVIEWS: ReviewsState = { items: [], error: null, fetchedAt: null, refreshing: false };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = () => vi.advanceTimersByTimeAsync(0);
const sentOfType = <T extends ControlToHelper['type']>(type: T) =>
  sent.filter((message): message is Extract<ControlToHelper, { type: T }> => message.type === type);
const rows = () => [...document.querySelectorAll<HTMLElement>('#workspaces li.ws[data-id]')];
const names = () => rows().map((row) => row.querySelector('.name')!.textContent);
const term = () => terms[0]!;
const socket = () => FakeSocket.instances.at(-1)!;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.resetModules();
  terms.length = 0;
  FakeSocket.instances = [];
  sent = [];
  helperUp = true;
  startHelper.mockReset();
  startHelper.mockResolvedValue(undefined);
  fake = installChrome();
  windowId = fake.addWindow('https://example.com/start').windowId;
  loadPanelHtml();
  Element.prototype.scrollIntoView = vi.fn();
  // The system is dark; following it as it changes is appearance.test.ts's concern.
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} }));
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function boot() {
  await import('./panel');
  await flush();
}

/** What the helper sends on every change. */
function state(
  workspaces: Workspace[],
  statuses: Record<string, WorkspaceStatus> = {},
  reviews: ReviewsState = REVIEWS,
  waiting: Record<string, WaitingOn> = {},
) {
  onControlMessage({ type: 'state', workspaces, statuses, waiting, reviews });
}
const ws = (id: string, overrides: Partial<Workspace> = {}) => makeWorkspace({ id, name: `acme/${id}`, windowId, ...overrides });

// The list's own behaviour (rows, filter, menu, rename, keys, drag, archived) is covered in workspace-list.test.ts;
// here only the wiring from the panel to the list is checked.
describe('the list', () => {
  it('shows each workspace from a state message, numbered, with its name and what it is doing', async () => {
    await boot();
    state([ws('a'), ws('b')], { a: 'working', b: 'needs_input' });
    expect(names()).toEqual(['acme/a', 'acme/b']);
    expect(rows().map((row) => row.querySelector('.badge')!.textContent)).toEqual(['1', '2']);
    expect(rows().map((row) => row.querySelector<HTMLElement>('.badge')!.dataset.status)).toEqual(['working', 'needs_input']);
    expect(rows()[1]!.getAttribute('aria-label')).toBe('acme/b, needs input');
  });

  it('shows why a workspace could not be created', async () => {
    await boot();
    onControlMessage({ type: 'createError', name: 'PROJ-1', message: 'Could not make a worktree for PROJ-1: not a git repository' });
    expect($('notice').hidden).toBe(false);
    expect($('notice').textContent).toBe('Could not make a worktree for PROJ-1: not a git repository');
  });

  it('shows the one selected for this window, when it holds several', async () => {
    fake.storage.local.selectedByWindow = { [windowId]: 'b' };
    await boot();
    state([ws('a'), ws('b')]);
    await flush();
    expect(rows().map((row) => row.classList.contains('current'))).toEqual([false, true]);
  });
});

describe('opening a workspace', () => {
  it('opens its window and side panel on click, and remembers the choice', async () => {
    const { windowId: other } = fake.addWindow('https://example.com/other');
    await boot();
    state([ws('a'), ws('b', { windowId: other })]);
    rows()[1]!.click();
    await flush();
    expect(fake.mock.sidePanel.open).toHaveBeenCalledWith({ windowId: other });
    expect(fake.storage.local.selectedByWindow).toEqual({ [other]: 'b' });
  });

  it('closes the new-workspace and diff views when the current workspace is clicked', async () => {
    await boot();
    state([ws('a')]);
    $('new').click();
    expect(creatorOpen()).toBe(true);
    rows()[0]!.click();
    expect(creatorOpen()).toBe(false);
  });

  it('follows the tab being worked in, to its workspace', async () => {
    const tab = fake.addTab(windowId, 'https://example.com/b', { active: true });
    const groupB = fake.addGroup([tab.id]);
    const tabA = fake.addTab(windowId, 'https://example.com/a');
    const groupA = fake.addGroup([tabA.id]);
    await boot();
    state([ws('a', { groupId: groupA }), ws('b', { groupId: groupB })]);
    fake.events.tabs.onActivated.emit({ windowId, tabId: tab.id });
    await flush();
    expect(fake.storage.local.selectedByWindow).toEqual({ [windowId]: 'b' });
  });

  it('ignores tab changes in other windows, in no group, or already on the current workspace', async () => {
    const { windowId: other } = fake.addWindow();
    await boot();
    state([ws('a')]);
    fake.events.tabs.onActivated.emit({ windowId: other, tabId: 1 });
    fake.events.tabs.onActivated.emit({ windowId, tabId: 1 });
    await flush();
    expect(fake.storage.local.selectedByWindow).toBeUndefined();
  });

  it('switches to a workspace that has just joined this window', async () => {
    await boot();
    state([ws('a')]);
    state([ws('a'), ws('b')]);
    await flush();
    expect(fake.storage.local.selectedByWindow).toEqual({ [windowId]: 'b' });
    expect(rows().map((row) => row.classList.contains('current'))).toEqual([false, true]);
  });

  it('does not treat the first state as anyone joining', async () => {
    await boot();
    state([ws('a'), ws('b')]);
    await flush();
    expect(fake.storage.local.selectedByWindow).toBeUndefined();
  });
});

/** Whether the new-workspace view is showing, which is what its own tests cover in depth. */
const creatorOpen = () => !$('create').hidden;

describe('review requests', () => {
  const review = makeReview({ url: 'https://github.com/acme/app/pull/12', number: 12, repo: 'acme/app' });
  const reviews: ReviewsState = { items: [review], error: null, fetchedAt: null, refreshing: false };
  const clickReview = async () => {
    (document.querySelector('#reviews-list > li') as HTMLElement).click();
    await flush();
  };

  it('opens the new-workspace view for the PR, and the PR as a plain tab beside a workspace’s tab group, not in it', async () => {
    const tab = fake.addTab(windowId, 'https://example.com/a');
    const groupId = fake.addGroup([tab.id]);
    await boot();
    state([ws('a', { groupId })], {}, reviews);
    await clickReview();
    expect(creatorOpen()).toBe(true);
    expect($<HTMLInputElement>('create-name').value).toBe('app#12');
    const opened = fake.mock.tabs.query({ windowId }).then((tabs) => tabs.find((t) => t.url === review.url));
    await expect(opened).resolves.toMatchObject({ groupId: -1 });
  });

  it('opens it in the window, as a tab outside any group, for a workspace that owns its window', async () => {
    await boot();
    state([ws('a', { groupId: null })], {}, reviews);
    await clickReview();
    const tabs = await fake.mock.tabs.query({ windowId });
    expect(tabs.find((t) => t.url === review.url)).toMatchObject({ groupId: -1 });
  });

  it('notes the tab it opened, so the workspace made for the PR takes it', async () => {
    await boot();
    state([ws('a')], {}, reviews);
    await clickReview();
    expect(fake.storage.session.reviewTab).toMatchObject({ url: review.url });
  });

  it('does not open a second copy of a PR that is already in a tab', async () => {
    fake.addTab(windowId, review.url);
    await boot();
    state([ws('a')], {}, reviews);
    await clickReview();
    const tabs = await fake.mock.tabs.query({ windowId });
    expect(tabs.filter((t) => t.url === review.url)).toHaveLength(1);
    expect(fake.storage.session.reviewTab).toBeUndefined();
  });

  it('opens the workspace that already exists for the PR, rather than the creation view', async () => {
    await boot();
    state([ws('a', { pr: review.url })], {}, reviews);
    await clickReview();
    expect(creatorOpen()).toBe(false);
  });
});

describe('archiving and the context menu', () => {
  it('asks twice before archiving, and the first click disarms after three seconds', async () => {
    await boot();
    state([ws('a')]);
    const remove = () => rows()[0]!.querySelector<HTMLButtonElement>('.remove')!;
    remove().click();
    expect(remove().textContent).toBe('archive?');
    expect(sentOfType('remove')).toEqual([]);
    vi.advanceTimersByTime(3000);
    expect(remove().textContent).toBe('');
    expect(remove().querySelector('use')?.getAttribute('href')).toBe('#i-x');
    remove().click();
    remove().click();
    expect(sentOfType('remove')).toEqual([{ type: 'remove', id: 'a' }]);
  });

  it('opens a workspace in its own window from its row, without selecting it', async () => {
    await boot();
    state([ws('a'), ws('b')]);
    const popOut = rows()[1]!.querySelector<HTMLButtonElement>('.pop-out')!;
    expect(popOut.querySelector('use')?.getAttribute('href')).toBe('#i-external');
    popOut.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.mock.windows.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'popup', url: 'chrome-extension://ext-id/popout.html?ws=b' }));
    expect(rows()[0]!.classList.contains('current')).toBe(true);
  });

  const menuButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu > button')];
  const openMenu = async (workspace: Workspace) => {
    await boot();
    state([workspace]);
    rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  };

  it("opens a shell in the workspace's directory from its menu", async () => {
    await openMenu(ws('a'));
    menuButtons()
      .find((b) => b.textContent === 'Open a shell here')!
      .click();
    expect($('tool').hidden).toBe(false);
    expect($('tool-title').textContent).toBe('Terminal · acme/a');
  });
});

describe('renaming', () => {
  const startRename = async (workspace = ws('a')) => {
    await boot();
    state([workspace]);
    rows()[0]!
      .querySelector('.name')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return document.querySelector<HTMLInputElement>('input.rename')!;
  };

  it('swaps the name for a box holding it, and sends the new one on Enter', async () => {
    const input = await startRename();
    expect(input.value).toBe('acme/a');
    input.value = '  better  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(sentOfType('rename')).toEqual([{ type: 'rename', id: 'a', name: 'better' }]);
    expect(document.querySelector('input.rename')).toBeNull();
  });
});

describe('the keyboard in the list', () => {
  const press = (target: Element, key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  it('opens on Enter or Space, and starts a rename on F2', async () => {
    const { windowId: other } = fake.addWindow();
    await boot();
    state([ws('a'), ws('b', { windowId: other })]);
    expect(press(rows()[1]!, 'Enter').defaultPrevented).toBe(true);
    press(rows()[1]!, ' ');
    await flush();
    expect(fake.mock.sidePanel.open).toHaveBeenCalledTimes(2);
    press(rows()[0]!, 'F2');
    expect(document.querySelector('input.rename')).not.toBeNull();
  });

  it('leaves keys alone while typing in the rename box', async () => {
    await boot();
    state([ws('a'), ws('b')]);
    rows()[0]!
      .querySelector('.name')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const input = document.querySelector('input.rename')!;
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
    listEventOnInput(input, event);
    expect(event.defaultPrevented).toBe(false);
  });
});

/** The rename box stops its own keys, so the list sees them only if it was not the target; this checks the list's own guard. */
function listEventOnInput(input: Element, event: KeyboardEvent) {
  $('workspaces').dispatchEvent(Object.defineProperty(event, 'target', { value: input }));
}

describe('reordering by dragging', () => {
  const drag = (type: string, target: Element, init: { clientY?: number } = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
    event.dataTransfer = { setData() {}, effectAllowed: '' };
    event.clientY = init.clientY ?? 0;
    target.dispatchEvent(event);
    return event;
  };

  it('moves a workspace after the one it is dropped on, in the lower half', async () => {
    await boot();
    state([ws('a'), ws('b'), ws('c')]);
    const [a, , c] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    drag('dragstart', a);
    expect(a.classList.contains('dragging')).toBe(true);
    c.getBoundingClientRect = () => ({ top: 0, height: 10 }) as DOMRect;
    drag('dragover', c, { clientY: 9 });
    expect(c.classList.contains('drop-after')).toBe(true);
    drag('drop', c);
    expect(sentOfType('move')).toEqual([{ type: 'move', id: 'a', index: 2 }]);
    drag('dragend', a);
    expect(names()).toEqual(['acme/b', 'acme/c', 'acme/a']);
  });
});

describe('archived workspaces', () => {
  const history: HistoryEntry[] = [makeHistoryEntry({ id: 'h1', name: 'old/one', resumeId: 'r1' }), makeHistoryEntry({ id: 'h2', name: 'old/two' })];
  const toggle = () => document.querySelector<HTMLElement>('.archived-toggle');
  const closed = () => [...document.querySelectorAll<HTMLElement>('.ws.closed')];

  it('folds them under a count, and opens the list on click', async () => {
    await boot();
    onControlMessage({ type: 'history', entries: history });
    expect(toggle()!.textContent).toBe('Archived (2)');
    expect(toggle()!.querySelector('.caret.open')).toBeNull();
    expect(closed()).toHaveLength(0);
    toggle()!.click();
    expect(toggle()!.textContent).toContain('Archived (2)');
    expect(toggle()!.querySelector('.caret.open')).not.toBeNull();
    expect(closed().map((row) => row.querySelector('.name')!.textContent)).toEqual(['old/one', 'old/two']);
    expect(closed()[0]!.title).toContain('Resumes its conversation');
    expect(closed()[1]!.title).not.toContain('Resumes');
  });

  it('restores into this window, as a tab group, when it already holds a workspace', async () => {
    await boot();
    state([ws('a')]);
    onControlMessage({ type: 'history', entries: history });
    toggle()!.click();
    closed()[1]!.click();
    expect(sentOfType('restore')).toEqual([{ type: 'restore', historyId: 'h2', windowId }]);
  });
});

describe('a window with no workspace', () => {
  it('offers the picker, filled from the workspaces, and pairs the one chosen', async () => {
    await boot();
    state([ws('near', { windowId: null, lastTabUrls: ['https://example.com/start'] })]);
    await flush();
    expect($('picker').hidden).toBe(false);
    expect($('terminal').hidden).toBe(true);
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('#picker-options button')];
    expect(buttons.map((b) => b.firstChild!.textContent)).toEqual(['acme/near']);
    buttons[0]!.click();
    expect(sentOfType('pair')).toEqual([{ type: 'pair', id: 'near', windowId }]);
  });

  it('shows the terminal instead once the window has a workspace', async () => {
    await boot();
    state([ws('a')]);
    expect($('picker').hidden).toBe(true);
    expect($('terminal').hidden).toBe(false);
  });
});

describe('the terminal', () => {
  it('attaches to the session of the workspace in view, once', async () => {
    await boot();
    state([ws('a')]);
    await flush();
    expect(FakeSocket.instances.map((s) => s.path)).toEqual(['/attach?session=a']);
    state([ws('a')], { a: 'working' });
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(term().resets).toBe(1);
  });

  it('switches session when the workspace in view changes, dropping the old connection', async () => {
    await boot();
    state([ws('a'), ws('b')]);
    await flush();
    const first = socket();
    rows()[1]!.click();
    await flush();
    state([ws('a'), ws('b')]);
    await flush();
    expect(first.closed).toBe(true);
    expect(socket().path).toBe('/attach?session=b');
  });

  it('detaches when there is no workspace to show', async () => {
    await boot();
    state([ws('a')]);
    await flush();
    const first = socket();
    state([]);
    expect(first.closed).toBe(true);
  });

  it('fits and sends its size when connected', async () => {
    await boot();
    state([ws('a')]);
    await flush();
    socket().onopen!();
    expect(socket().sent).toEqual([{ type: 'resize', cols: 80, rows: 24 }]);
  });

  it('writes output, and drops the terminal’s replies to replayed output', async () => {
    await boot();
    state([ws('a')]);
    await flush();
    socket().receive({ type: 'output', data: 'hello', replay: false });
    expect(term().written).toEqual(['hello']);
    socket().receive({ type: 'output', data: 'old', replay: true });
    term().onDataListener!('\x1b[?1;2c');
    expect(socket().sent.filter((m) => m.type === 'input')).toEqual([]);
    term().pendingWrite!();
    term().onDataListener!('ls');
    expect(socket().sent.filter((m) => m.type === 'input')).toEqual([{ type: 'input', data: 'ls' }]);
  });

  it('pastes the path of an uploaded file, or says why it failed', async () => {
    await boot();
    state([ws('a')]);
    await flush();
    socket().receive({ type: 'uploaded', name: 'shot.png', path: '/tmp/up/shot.png' });
    expect(term().pasted).toEqual(['/tmp/up/shot.png ']);
    socket().receive({ type: 'uploaded', name: 'big.bin', path: null, error: 'too large' });
    expect($('notice').textContent).toBe('Could not add big.bin: too large');
    socket().receive({ type: 'uploaded', name: 'x', path: null });
    expect($('notice').textContent).toBe('Could not add x: unknown error');
  });

  it('closes the side panel when the shell exits', async () => {
    await boot();
    state([ws('a')]);
    await flush();
    socket().receive({ type: 'exit' });
    expect(fake.mock.sidePanel.close).toHaveBeenCalledWith({ windowId });
  });

  it('says so in the terminal when the helper drops the connection', async () => {
    await boot();
    state([ws('a')]);
    await flush();
    socket().onclose!();
    expect(term().written.join('')).toContain('disconnected from helper');
  });

  it('attaches again when the helper replaces the session', async () => {
    await boot();
    state([ws('a')]);
    await flush();
    const first = socket();
    onControlMessage({ type: 'sessionReset', id: 'a' });
    await flush();
    expect(first.closed).toBe(true);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it('ignores a session reset for a workspace it is not attached to', async () => {
    await boot();
    state([ws('a')]);
    await flush();
    onControlMessage({ type: 'sessionReset', id: 'other' });
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it('tries again at the next state when the helper could not be reached', async () => {
    helperUp = false;
    await boot();
    state([ws('a')]);
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    helperUp = true;
    state([ws('a')]);
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
  });

  describe('keys', () => {
    const key = (init: KeyboardEventInit & { key: string }, type = 'keydown') => new KeyboardEvent(type, init);

    it('sends Shift+Enter as escape and carriage return, which claude reads as a newline', async () => {
      await boot();
      state([ws('a')]);
      await flush();
      expect(term().keyHandler!(key({ key: 'Enter', shiftKey: true }))).toBe(false);
      expect(socket().sent).toContainEqual({ type: 'input', data: '\x1b\r' });
    });

    it('sends it once, not again on key up', async () => {
      await boot();
      state([ws('a')]);
      await flush();
      expect(term().keyHandler!(key({ key: 'Enter', shiftKey: true }, 'keyup'))).toBe(false);
      expect(socket().sent.filter((m) => m.type === 'input')).toEqual([]);
    });

    it('lets plain Enter and other chords through', async () => {
      await boot();
      state([ws('a')]);
      await flush();
      expect(term().keyHandler!(key({ key: 'Enter' }))).toBe(true);
      expect(term().keyHandler!(key({ key: 'Enter', shiftKey: true, ctrlKey: true }))).toBe(true);
      expect(term().keyHandler!(key({ key: 'a' }))).toBe(true);
    });

    it('declines the palette shortcut so the page can have it', async () => {
      await boot();
      expect(term().keyHandler!(key({ key: 'k', metaKey: true }))).toBe(false);
      expect(term().keyHandler!(key({ key: 'K', ctrlKey: true }))).toBe(false);
      expect(term().keyHandler!(key({ key: 'k', metaKey: true, shiftKey: true }))).toBe(true);
    });
  });
});

describe('links and search in the terminal', () => {
  const press = (init: KeyboardEventInit, target: EventTarget = document) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { cancelable: true, bubbles: true, ...init }));
  const input = () => $<HTMLInputElement>('term-search-input');
  const key = (init: KeyboardEventInit & { key: string }) => new KeyboardEvent('keydown', init);

  it('opens a link clicked in the terminal in a new tab', async () => {
    await boot();
    linkHandlers.at(-1)!(new MouseEvent('click'), 'https://example.com/x');
    expect(fake.mock.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/x' });
  });

  it('finds in the terminal from ⌘F: Enter for the next match, Shift+Enter for the previous, Escape to close', async () => {
    await boot();
    expect($('term-search').hidden).toBe(true);
    expect(term().keyHandler!(key({ key: 'f', metaKey: true }))).toBe(false);
    // The box belongs to the terminal, so it only opens while one is showing.
    press({ key: 'f', metaKey: true });
    expect($('term-search').hidden).toBe(true);
    $('terminal').hidden = false;
    press({ key: 'f', metaKey: true });
    expect($('term-search').hidden).toBe(false);
    expect(document.activeElement).toBe(input());
    // Each boot makes its own; the latest is this test's.
    const search = FakeSearch.instances.at(-1)!;
    input().value = 'error';
    input().dispatchEvent(new Event('input'));
    expect(search.findNext).toHaveBeenLastCalledWith('error', expect.objectContaining({ incremental: true }));
    press({ key: 'Enter' }, input());
    expect(search.findNext).toHaveBeenLastCalledWith('error', expect.objectContaining({ incremental: false }));
    press({ key: 'Enter', shiftKey: true }, input());
    expect(search.findPrevious).toHaveBeenCalledWith('error', expect.anything());
    press({ key: 'Escape' }, input());
    expect($('term-search').hidden).toBe(true);
    expect(search.clearDecorations).toHaveBeenCalled();
    // A second ⌘F with the box open just refocuses it; the palette's key is untouched.
    press({ key: 'f', metaKey: true });
    press({ key: 'f', metaKey: true });
    expect($('term-search').hidden).toBe(false);
    $('term-search-close').click();
    expect($('term-search').hidden).toBe(true);
  });
});

describe('the command palette', () => {
  const press = (init: KeyboardEventInit) => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', cancelable: true, ...init }));
  const labels = () =>
    [...document.querySelectorAll('#palette-results .palette-row')].map(
      (row) => `${row.querySelector('.palette-kind')!.textContent}: ${row.querySelector('.palette-label')!.textContent}`,
    );

  it('opens on ⌘K or Ctrl+K and closes on the same key', async () => {
    await boot();
    press({ metaKey: true });
    expect($('palette').hidden).toBe(false);
    press({ ctrlKey: true });
    expect($('palette').hidden).toBe(true);
  });

  it('ignores K with Shift or Alt, or alone', async () => {
    await boot();
    press({});
    press({ metaKey: true, shiftKey: true });
    press({ metaKey: true, altKey: true });
    expect($('palette').hidden).toBe(true);
  });

  it('lists the actions and the workspaces, archived ones and review requests from the state', async () => {
    await boot();
    state([ws('a')], {}, { items: [makeReview({ number: 12, title: 'Add it' })], error: null, fetchedAt: null, refreshing: false });
    onControlMessage({ type: 'history', entries: [makeHistoryEntry({ name: 'old/one' })] });
    press({ metaKey: true });
    expect(labels()).toContain('Action: New workspace');
    expect(labels()).toContain('Workspace: acme/a');
    expect(labels()).toContain('Restore: old/one');
    expect(labels()).toContain('Review: app#12 Add it');
  });

  it('runs an action: new workspace opens the creation view', async () => {
    await boot();
    state([ws('a')]);
    press({ metaKey: true });
    const input = $<HTMLInputElement>('palette-input');
    input.value = 'new workspace';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    expect(creatorOpen()).toBe(true);
    expect($('palette').hidden).toBe(true);
  });

  it('runs a review: starting the workspace for it', async () => {
    const review = makeReview({ url: 'https://github.com/acme/app/pull/12', title: 'Add it' });
    await boot();
    state([ws('a')], {}, { items: [review], error: null, fetchedAt: null, refreshing: false });
    press({ metaKey: true });
    const input = $<HTMLInputElement>('palette-input');
    input.value = 'app#12';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    expect(creatorOpen()).toBe(true);
    expect($<HTMLInputElement>('create-name').value).toBe('app#12');
  });

  it('runs refresh review requests, source control and collapse', async () => {
    await boot();
    state([ws('a')]);
    const run = (query: string) => {
      press({ metaKey: true });
      const input = $<HTMLInputElement>('palette-input');
      input.value = query;
      input.dispatchEvent(new Event('input'));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    };
    sent.length = 0;
    run('refresh review');
    expect(sentOfType('refreshReviews')).toHaveLength(1);
    run('collapse');
    expect(document.body.classList.contains('collapsed')).toBe(true);
    press({ metaKey: true });
    expect(labels()).toContain('Action: Expand the list');
  });
});

describe('the other views', () => {
  it('shows only one of settings, the creation view, the diff and the tools at a time', async () => {
    await boot();
    state([ws('a')]);
    $('new').click();
    expect(creatorOpen()).toBe(true);
    $('settings-open').click();
    expect($('settings').hidden).toBe(false);
    expect(creatorOpen()).toBe(false);
    expect($('terminal').hidden).toBe(true);
    $('monitor-open').click();
    expect($('tool').hidden).toBe(false);
    expect($('settings').hidden).toBe(true);
    $('monitor-open').click();
    expect($('tool').hidden).toBe(true);
    expect($('terminal').hidden).toBe(false);
  });

  it('switches between the monitor and the shell from their buttons', async () => {
    await boot();
    state([ws('a')]);
    $('monitor-open').click();
    expect($('tool-title').textContent).toBe('System monitor');
    $('shell-open').click();
    expect($('tool-title').textContent).toBe('Terminal');
  });

  it('keeps the activity section on the workspace in view, following each switch', async () => {
    await boot();
    state([ws('a'), ws('b')]);
    expect(sent.filter((m) => m.type === 'activity')).toEqual([{ type: 'activity', id: 'a' }]);
    onControlMessage({ type: 'activity', id: 'a', items: [], error: null });
    expect($('activity-body').textContent).toContain('Nothing yet');
    rows()[1]!.click();
    await flush();
    state([ws('a'), ws('b')]);
    expect(sent.filter((m) => m.type === 'activity').at(-1)).toEqual({ type: 'activity', id: 'b' });
    // Opening another view leaves the section where it is.
    $('settings-open').click();
    expect($('activity').hidden).toBe(false);
    expect(sent.filter((m) => m.type === 'activity').length).toBe(2);
  });

  it('closes the overlay views when the workspace in view changes', async () => {
    await boot();
    state([ws('a'), ws('b')]);
    $('settings-open').click();
    rows()[1]!.click();
    await flush();
    state([ws('a'), ws('b')]);
    expect($('settings').hidden).toBe(true);
  });

  it('routes git, prompt, repo and PR messages to their views', async () => {
    await boot();
    state([ws('a')]);
    onControlMessage({ type: 'prompts', prompts: [{ section: 'S', text: 'Do it' }], error: null });
    $('new').click();
    expect(document.querySelectorAll('#create-prompts .prompt')).toHaveLength(1);
    onControlMessage({ type: 'repos', repos: [{ name: 'app', path: '/Users/me/app', root: '/Users/me' }] });
    expect([...$<HTMLSelectElement>('create-repo').options].map((option) => option.textContent)).toContain('app');
    onControlMessage({
      type: 'git',
      id: 'a',
      state: { root: '/r', worktree: null, branch: 'feature/x', upstream: null, ahead: 0, behind: 0, files: [], commits: [] },
      error: null,
    });
    expect(document.querySelector('.git-branch-name')!.textContent).toContain('feature/x');
  });

  it('counts the settings view’s warnings and setup steps on the settings button', async () => {
    await boot();
    const snapshot = makeSnapshot();
    onControlMessage({ type: 'system', snapshot: { ...snapshot, warnings: [{ id: 'a', name: 'acme/a', kind: 'memory', message: 'big' }] }, error: null });
    expect($('settings-open').classList.contains('has-warning')).toBe(true);
    expect($('settings-open').title).toBe('Settings · 2 to look at');
  });

  it('asks for system status when it starts, and every 15 seconds while settings is closed', async () => {
    await boot();
    expect(sentOfType('system')).toHaveLength(1);
    vi.advanceTimersByTime(15_000);
    expect(sentOfType('system')).toHaveLength(2);
    $('settings-open').click();
    sent.length = 0;
    vi.advanceTimersByTime(15_000);
    // Settings polls faster itself while it is showing.
    expect(sentOfType('system').length).toBeGreaterThan(0);
  });
});

describe('connection', () => {
  it('says the helper is not running while disconnected, and clears the notice once connected', async () => {
    await boot();
    onConnected(false);
    expect($('notice').hidden).toBe(false);
    expect($('notice').textContent).toContain('Helper not running.');
    onConnected(true);
    expect($('notice').hidden).toBe(true);
  });
});

describe('appearance', () => {
  it('applies the saved theme and density to the page and the terminal', async () => {
    fake.storage.local.prefs = { theme: 'light', density: 'compact' };
    await boot();
    // happy-dom picks the wrong option for `light`, but the prefs are read straight from storage here.
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.dataset.density).toBe('compact');
    expect(term().options.theme!.background).toBe('#ffffff');
  });
});

describe('the list’s width and collapse', () => {
  it('collapses and expands the list, remembering which', async () => {
    await boot();
    $('collapse').click();
    expect(document.body.classList.contains('collapsed')).toBe(true);
    expect(fake.storage.local.listCollapsed).toBe(true);
    $('collapse').click();
    expect(fake.storage.local.listCollapsed).toBe(false);
  });

  it('starts collapsed and at its saved width, within limits', async () => {
    fake.storage.local.listCollapsed = true;
    fake.storage.local.listWidth = 9999;
    await boot();
    expect(document.body.classList.contains('collapsed')).toBe(true);
    expect(document.body.style.getPropertyValue('--list-width')).toBe('520px');
  });
});
