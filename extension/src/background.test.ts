import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlToClient, ControlToHelper, WaitingOn, WorkspaceStatus } from '../../shared/protocol/protocol';
import { installChrome } from '../testing/chrome-mock';
import { makeWorkspace } from '../testing/fixtures';

const REVIEWS = { items: [], fetchedAt: null, error: null, loading: false } as unknown as Extract<ControlToClient, { type: 'state' }>['reviews'];

let fake: ReturnType<typeof installChrome>;
let handle: (message: ControlToClient) => void;
let sent: ControlToHelper[];

/** Runs the service worker's top level against the fake, capturing what it sends the helper. */
async function boot(options: { fresh?: boolean } = {}) {
  vi.resetModules();
  sent = [];
  vi.doMock('./app/helper-client', () => ({
    connectControl: (onMessage: (message: ControlToClient) => void) => {
      handle = onMessage;
      return { send: (message: ControlToHelper) => (sent.push(message), true), connected: true };
    },
  }));
  await import('./background');
  // `fresh` is whether Chrome just started; an extension reload, which keeps window ids, is the other case.
  (options.fresh ? fake.events.runtime.onStartup : fake.events.runtime.onInstalled).emit();
  await settle();
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const state = (workspaces: ReturnType<typeof makeWorkspace>[], statuses: Record<string, WorkspaceStatus> = {}, waiting: Record<string, WaitingOn> = {}) =>
  handle({ type: 'state', workspaces, statuses, waiting, reviews: REVIEWS });
const sentOfType = <T extends ControlToHelper['type']>(type: T) =>
  sent.filter((message): message is Extract<ControlToHelper, { type: T }> => message.type === type);

beforeEach(() => {
  vi.useFakeTimers();
  fake = installChrome();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.doUnmock('./app/helper-client');
});

describe('startup', () => {
  it('opens the side panel from the toolbar button, and sets an alarm that keeps the worker alive', async () => {
    await boot();
    expect(fake.mock.sidePanel.setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
    expect(fake.mock.alarms.create).toHaveBeenCalledWith('wake', { periodInMinutes: 1 });
  });

  it('drops every pairing on the first state after Chrome restarts, because window ids were reissued', async () => {
    await boot({ fresh: true });
    state([makeWorkspace({ id: 'ws-a', windowId: 7 }), makeWorkspace({ id: 'ws-b', windowId: null }), makeWorkspace({ id: 'ws-c', windowId: 9 })]);
    await settle();
    expect(sentOfType('unpair')).toEqual([
      { type: 'unpair', windowId: 7 },
      { type: 'unpair', windowId: 9 },
    ]);

    state([makeWorkspace({ id: 'ws-a', windowId: 7 })]);
    await settle();
    expect(sentOfType('unpair')).toHaveLength(2);
  });

  it('keeps pairings across an extension reload, which does not change window ids', async () => {
    await boot({ fresh: false });
    state([makeWorkspace({ id: 'ws-a', windowId: 7 })]);
    await settle();
    expect(sentOfType('unpair')).toEqual([]);
  });

  it('treats a worker restarted within the same browser session as not fresh', async () => {
    fake.storage.session.started = true;
    await boot({ fresh: false });
    state([makeWorkspace({ id: 'ws-a', windowId: 7 })]);
    await settle();
    expect(sentOfType('unpair')).toEqual([]);
  });
});

describe('re-pairing', () => {
  it('pairs a workspace whose window id is gone with the open window holding its tabs', async () => {
    const { windowId } = fake.addWindow('https://example.com/a');
    fake.addTab(windowId, 'https://example.com/b');
    await boot();
    state([makeWorkspace({ id: 'ws-a', windowId: null, lastTabUrls: ['https://example.com/a', 'https://example.com/b'] })]);
    await settle();
    expect(sentOfType('pair')).toEqual([{ type: 'pair', id: 'ws-a', windowId }]);
  });

  it('follows its tabs into a tab group when the window was merged into another', async () => {
    const { windowId, tab } = fake.addWindow('https://other.example/0');
    // Enough other tabs that the window as a whole no longer looks like the workspace's.
    for (const n of [1, 2, 3, 4]) fake.addTab(windowId, `https://other.example/${n}`);
    const one = fake.addTab(windowId, 'https://example.com/a');
    const two = fake.addTab(windowId, 'https://example.com/b');
    const groupId = fake.addGroup([one.id, two.id]);
    expect(tab.groupId).toBe(-1);
    await boot();
    state([makeWorkspace({ id: 'ws-a', windowId: null, lastTabUrls: ['https://example.com/a', 'https://example.com/b'] })]);
    await settle();
    expect(sentOfType('pair')).toEqual([{ type: 'pair', id: 'ws-a', windowId, groupId }]);
  });

  it('re-pairs when a tab group is created or a window closes, once things settle', async () => {
    await boot();
    state([makeWorkspace({ id: 'ws-a', windowId: null, lastTabUrls: ['https://example.com/a'] })]);
    await settle();
    expect(sentOfType('pair')).toEqual([]);

    const { windowId, tab } = fake.addWindow('https://example.com/a');
    fake.events.tabGroups.onCreated.emit(fake.group(fake.addGroup([tab.id]))!);
    await vi.advanceTimersByTimeAsync(1499);
    expect(sentOfType('pair')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sentOfType('pair')).toContainEqual({ type: 'pair', id: 'ws-a', windowId });
  });

  it('renames a tab group to match its renamed workspace', async () => {
    const { windowId, tab } = fake.addWindow();
    const groupId = fake.addGroup([tab.id], { title: 'old name' });
    await boot();
    state([makeWorkspace({ id: 'ws-a', name: 'new name', windowId, groupId })]);
    await settle();
    expect(fake.group(groupId)?.title).toBe('new name');
  });

  it('leaves a group whose title already matches, and one that has closed', async () => {
    const { windowId, tab } = fake.addWindow();
    const groupId = fake.addGroup([tab.id], { title: 'same' });
    await boot();
    state([makeWorkspace({ id: 'ws-a', name: 'same', windowId, groupId }), makeWorkspace({ id: 'ws-b', name: 'gone', windowId, groupId: 999 })]);
    await settle();
    expect(fake.mock.tabGroups.update).not.toHaveBeenCalled();
  });
});

describe('opening workspaces', () => {
  it('opens a window, or makes a group, for a workspace the helper asks about', async () => {
    const { windowId } = fake.addWindow();
    await boot();
    state([makeWorkspace({ id: 'ws-a', url: 'https://example.com/a' }), makeWorkspace({ id: 'ws-b', windowId, lastTabUrls: ['https://example.com/b'] })]);
    await settle();

    handle({ type: 'open', id: 'ws-a' });
    handle({ type: 'group', id: 'ws-b' });
    await settle();

    expect(fake.mock.windows.create).toHaveBeenCalledTimes(1);
    expect(sentOfType('pair')).toEqual([
      expect.objectContaining({ id: 'ws-a' }),
      expect.objectContaining({ id: 'ws-b', windowId, groupId: expect.any(Number) }),
    ]);
  });

  it('holds an open or group request that arrives before the state listing its workspace', async () => {
    const { windowId } = fake.addWindow();
    await boot();
    handle({ type: 'open', id: 'ws-a' });
    handle({ type: 'group', id: 'ws-b' });
    await settle();
    expect(fake.mock.windows.create).not.toHaveBeenCalled();

    state([makeWorkspace({ id: 'ws-a', url: 'https://example.com/a' }), makeWorkspace({ id: 'ws-b', windowId, lastTabUrls: ['https://example.com/b'] })]);
    await settle();

    expect(fake.mock.windows.create).toHaveBeenCalledTimes(1);
    expect(fake.urls(windowId)).toContain('https://example.com/b');

    // Each is run once.
    state([makeWorkspace({ id: 'ws-a', url: 'https://example.com/a' })]);
    await settle();
    expect(fake.mock.windows.create).toHaveBeenCalledTimes(1);
  });

  it('brings a workspace forward on focus, and ignores one it does not know', async () => {
    const { windowId, tab } = fake.addWindow();
    const groupId = fake.addGroup([tab.id], { collapsed: true });
    await boot();
    state([makeWorkspace({ id: 'ws-a', windowId, groupId })]);
    await settle();

    handle({ type: 'focus', id: 'nope' });
    handle({ type: 'focus', id: 'ws-a' });
    await settle();

    expect(fake.group(groupId)?.collapsed).toBe(false);
    expect(fake.mock.windows.create).not.toHaveBeenCalled();
  });
});

describe('closeTabs', () => {
  it("closes a workspace's group tabs, leaving the rest of the window", async () => {
    const { windowId, tab: other } = fake.addWindow();
    const a = fake.addTab(windowId, 'https://example.com/a');
    const b = fake.addTab(windowId, 'https://example.com/b');
    const groupId = fake.addGroup([a.id, b.id]);
    await boot();

    handle({ type: 'closeTabs', windowId, groupId });
    await settle();

    expect(fake.urls(windowId)).toEqual([other.url]);
  });

  it('closes the whole window when the workspace had no group', async () => {
    const { windowId } = fake.addWindow();
    await boot();
    handle({ type: 'closeTabs', windowId, groupId: null });
    await settle();
    expect(fake.hasWindow(windowId)).toBe(false);
  });

  it('shrugs off a window or group that was already closed by hand', async () => {
    await boot();
    handle({ type: 'closeTabs', windowId: 404, groupId: null });
    handle({ type: 'closeTabs', windowId: 404, groupId: 405 });
    await settle();
    expect(fake.mock.tabs.remove).not.toHaveBeenCalled();
  });
});

describe('what each state drives', () => {
  // The modules behind these (attention, send-menu, order-sync) have tests of their own; this is the worker wiring them in.
  it('badges the workspaces waiting, lists them in the right-click menu and puts the tab groups in list order', async () => {
    const { windowId, tab } = fake.addWindow('https://example.com/a');
    const other = fake.addTab(windowId, 'https://example.com/b');
    const [ga, gb] = [fake.addGroup([tab.id]), fake.addGroup([other.id])] as [number, number];
    const a = makeWorkspace({ id: 'ws-a', name: 'acme/app', windowId, groupId: ga });
    const b = makeWorkspace({ id: 'ws-b', name: 'acme/api', windowId, groupId: gb });
    await boot();
    state([a, b], { 'ws-a': 'needs_input', 'ws-b': 'idle' });
    await settle();
    expect(fake.mock.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1' });
    expect(fake.mock.contextMenus.create.mock.calls.map(([item]) => (item as { id: string }).id)).toEqual(['send-to-workspace', 'send:ws-a', 'send:ws-b']);

    state([b, a]);
    await settle();
    expect((await fake.mock.tabs.query({ windowId })).map((t) => t.groupId)).toEqual([gb, ga]);
  });

  it('brings a workspace forward when its notification is clicked', async () => {
    const { windowId, tab } = fake.addWindow();
    const groupId = fake.addGroup([tab.id], { collapsed: true });
    await boot();
    state([makeWorkspace({ id: 'ws-a', windowId, groupId })]);
    await settle();
    fake.events.notifications.onClicked.emit('ws-ws-a');
    await settle();
    expect(fake.group(groupId)?.collapsed).toBe(false);
  });

  it('says whether text sent to a workspace arrived', async () => {
    await boot();
    state([makeWorkspace({ id: 'ws-a', name: 'acme/app' })]);
    await settle();
    handle({ type: 'sent', id: 'ws-a', ok: false, message: 'no terminal' });
    expect(fake.mock.notifications.create).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ title: 'Could not send to acme/app' }));
  });

  it('sends the text chosen from the right-click menu to the helper', async () => {
    await boot();
    fake.events.contextMenus.onClicked.emit({ menuItemId: 'send:ws-a', selectionText: 'hello', editable: false } as chrome.contextMenus.OnClickData, undefined);
    expect(sentOfType('sendText')).toEqual([{ type: 'sendText', id: 'ws-a', text: 'hello' }]);
  });
});

describe('tab tracking', () => {
  it("reports a workspace's tabs a second after they change, so a restart can re-pair it", async () => {
    const { windowId } = fake.addWindow('https://example.com/a');
    fake.addTab(windowId, 'chrome://extensions/');
    fake.addTab(windowId, 'https://example.com/b');
    await boot();
    state([makeWorkspace({ id: 'ws-a', windowId })]);
    await settle();

    fake.events.tabs.onCreated.emit({ windowId } as chrome.tabs.Tab);
    await vi.advanceTimersByTimeAsync(999);
    expect(sentOfType('tabs')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sentOfType('tabs')).toEqual([{ type: 'tabs', windowId, urls: ['https://example.com/a', 'https://example.com/b'] }]);
  });

  it('batches a burst of changes into one report', async () => {
    const { windowId } = fake.addWindow('https://example.com/a');
    await boot();
    state([makeWorkspace({ id: 'ws-a', windowId })]);
    await settle();
    for (let i = 0; i < 5; i++) {
      fake.events.tabs.onCreated.emit({ windowId } as chrome.tabs.Tab);
      await vi.advanceTimersByTimeAsync(200);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentOfType('tabs')).toHaveLength(1);
  });

  it('reports only the tabs in a workspace group, and leaves the others to their own workspace', async () => {
    const { windowId, tab } = fake.addWindow('https://example.com/loose');
    const mine = fake.addTab(windowId, 'https://example.com/mine');
    const theirs = fake.addTab(windowId, 'https://example.com/theirs');
    const groupA = fake.addGroup([mine.id]);
    const groupB = fake.addGroup([theirs.id]);
    expect(tab.groupId).toBe(-1);
    await boot();
    state([makeWorkspace({ id: 'ws-a', windowId, groupId: groupA }), makeWorkspace({ id: 'ws-b', windowId, groupId: groupB })]);
    await settle();

    fake.events.tabs.onUpdated.emit(mine.id, { groupId: groupA }, { windowId } as chrome.tabs.Tab);
    await vi.advanceTimersByTimeAsync(1000);

    expect(sentOfType('tabs')).toEqual([
      { type: 'tabs', windowId, urls: ['https://example.com/mine'], groupId: groupA },
      { type: 'tabs', windowId, urls: ['https://example.com/theirs'], groupId: groupB },
    ]);
  });

  it('gives a workspace without a group the tabs no group claims', async () => {
    const { windowId } = fake.addWindow('https://example.com/loose');
    const grouped = fake.addTab(windowId, 'https://example.com/grouped');
    const groupId = fake.addGroup([grouped.id]);
    await boot();
    state([makeWorkspace({ id: 'ws-a', windowId, groupId: null }), makeWorkspace({ id: 'ws-b', windowId, groupId })]);
    await settle();

    fake.events.tabs.onAttached.emit(1, { newWindowId: windowId } as chrome.tabs.OnAttachedInfo);
    await vi.advanceTimersByTimeAsync(1000);

    expect(sentOfType('tabs')[0]).toEqual({ type: 'tabs', windowId, urls: ['https://example.com/loose'] });
  });

  it('does not report for a window with no workspace, or one whose tabs are all gone', async () => {
    const { windowId } = fake.addWindow('https://example.com/a');
    await boot();
    state([makeWorkspace({ id: 'ws-a', windowId: 999 })]);
    await settle();
    fake.events.tabs.onCreated.emit({ windowId } as chrome.tabs.Tab);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentOfType('tabs')).toEqual([]);

    state([makeWorkspace({ id: 'ws-a', windowId: 77 })]);
    await settle();
    fake.events.tabs.onCreated.emit({ windowId: 77 } as chrome.tabs.Tab);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentOfType('tabs')).toEqual([]);
  });

  it('ignores updates that change neither address nor group, and tabs closing with their window', async () => {
    const { windowId } = fake.addWindow('https://example.com/a');
    await boot();
    state([makeWorkspace({ id: 'ws-a', windowId })]);
    await settle();
    fake.events.tabs.onUpdated.emit(1, { title: 'x' }, { windowId } as chrome.tabs.Tab);
    fake.events.tabs.onRemoved.emit(1, { windowId, isWindowClosing: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentOfType('tabs')).toEqual([]);

    fake.events.tabs.onRemoved.emit(1, { windowId, isWindowClosing: false });
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentOfType('tabs')).toHaveLength(1);
  });

  it('unpairs a closed group or window', async () => {
    await boot();
    fake.events.tabGroups.onRemoved.emit({ id: 5 } as chrome.tabGroups.TabGroup);
    fake.events.windows.onRemoved.emit(8);
    expect(sentOfType('unpairGroup')).toEqual([{ type: 'unpairGroup', groupId: 5 }]);
    expect(sentOfType('unpair')).toEqual([{ type: 'unpair', windowId: 8 }]);
  });

  it('records the size of a moved or resized window as the shared size', async () => {
    await boot();
    fake.events.windows.onBoundsChanged.emit({ type: 'normal', state: 'maximized' } as chrome.windows.Window);
    expect(fake.storage.local.sharedSize).toEqual({ maximized: true });
  });
});

describe('keyboard shortcuts', () => {
  /** Two workspaces sharing a window, each in its own group. */
  async function twoInOneWindow() {
    const { windowId, tab } = fake.addWindow('https://example.com/a');
    const other = fake.addTab(windowId, 'https://example.com/b');
    const groupA = fake.addGroup([tab.id]);
    const groupB = fake.addGroup([other.id], { collapsed: true });
    await boot();
    state([makeWorkspace({ id: 'ws-a', windowId, groupId: groupA }), makeWorkspace({ id: 'ws-b', windowId, groupId: groupB })]);
    await settle();
    return { windowId, groupA, groupB };
  }

  it('moves to the next and previous workspace, wrapping around, and reopens its side panel', async () => {
    const { windowId, groupA, groupB } = await twoInOneWindow();

    fake.events.commands.onCommand.emit('next-workspace');
    await settle();
    expect(fake.group(groupB)?.collapsed).toBe(false);
    expect(fake.group(groupA)?.collapsed).toBe(true);
    expect(fake.mock.sidePanel.open).toHaveBeenLastCalledWith({ windowId });
    expect(fake.storage.local.selectedByWindow).toEqual({ [windowId]: 'ws-b' });

    fake.events.commands.onCommand.emit('next-workspace');
    await settle();
    expect(fake.group(groupA)?.collapsed).toBe(false);

    fake.events.commands.onCommand.emit('prev-workspace');
    await settle();
    expect(fake.group(groupB)?.collapsed).toBe(false);
  });

  it('does nothing with no workspaces, with one, or for another command', async () => {
    const { windowId } = fake.addWindow();
    await boot();
    fake.events.commands.onCommand.emit('next-workspace');
    await settle();
    expect(fake.mock.sidePanel.open).not.toHaveBeenCalled();

    state([makeWorkspace({ id: 'ws-a', windowId })]);
    await settle();
    fake.events.commands.onCommand.emit('next-workspace');
    fake.events.commands.onCommand.emit('something-else');
    await settle();
    expect(fake.mock.sidePanel.open).not.toHaveBeenCalled();
  });
});
