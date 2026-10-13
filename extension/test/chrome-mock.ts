import { vi } from 'vitest';

/** A tab as the fake keeps it; `groupId` is -1 when the tab is in no group, as in Chrome. */
export interface FakeTab {
  id: number;
  windowId: number;
  groupId: number;
  url: string;
  active: boolean;
  lastAccessed: number;
  /** Left-to-right order within the window, as Chrome's `index` is derived from it. */
  position: number;
}

export interface FakeGroup {
  id: number;
  windowId: number;
  title?: string;
  color: chrome.tabGroups.Color;
  collapsed: boolean;
  shared: boolean;
}

const NONE = -1;

/** A `chrome.*.onX` event: listeners register with addListener, and tests fire it with emit. */
export function event<A extends unknown[]>() {
  const listeners: ((...args: A) => unknown)[] = [];
  return {
    addListener: vi.fn((listener: (...args: A) => unknown) => void listeners.push(listener)),
    emit: (...args: A) => listeners.forEach((listener) => listener(...args)),
  };
}

/**
 * An in-memory stand-in for the parts of `chrome.*` the extension's tab and window code uses.
 * It keeps real state (tabs, groups, windows, storage) so tests assert on outcomes rather than calls.
 */
export function installChrome() {
  let nextId = 1;
  let clock = 1;
  const tabs = new Map<number, FakeTab>();
  const groups = new Map<number, FakeGroup>();
  const windows = new Set<number>();
  const sessionStore: Record<string, unknown> = {};
  const localStore: Record<string, unknown> = {};
  /** Bounds Chrome should refuse, to exercise the fallbacks when a saved position is off screen. */
  const refuse = { positioned: false, sized: false };
  const windowUpdates: chrome.windows.UpdateInfo[] = [];

  const missing = (what: string, id: number) => Promise.reject(new Error(`No ${what} with id: ${id}.`));
  const inWindow = (windowId: number) => [...tabs.values()].filter((tab) => tab.windowId === windowId).sort((a, b) => a.position - b.position);
  const asTab = (tab: FakeTab) => ({ ...tab, pendingUrl: undefined, index: inWindow(tab.windowId).indexOf(tab) }) as unknown as chrome.tabs.Tab;

  function openWindow(): number {
    const id = nextId++;
    windows.add(id);
    return id;
  }
  function addTab(windowId: number, url: string, active: boolean): FakeTab {
    if (active) for (const tab of inWindow(windowId)) tab.active = false;
    const tab: FakeTab = { id: nextId++, windowId, groupId: NONE, url, active, lastAccessed: clock++, position: clock++ };
    tabs.set(tab.id, tab);
    return tab;
  }
  /** Chrome drops a group once its last tab leaves. */
  function pruneGroups(): void {
    for (const id of [...groups.keys()]) if (![...tabs.values()].some((tab) => tab.groupId === id)) groups.delete(id);
  }
  function removeTab(id: number): void {
    const tab = tabs.get(id);
    tabs.delete(id);
    // A window closes with its last tab.
    if (tab && inWindow(tab.windowId).length === 0) windows.delete(tab.windowId);
    pruneGroups();
  }

  const events = {
    tabs: {
      onActivated: event<[chrome.tabs.OnActivatedInfo]>(),
      onCreated: event<[chrome.tabs.Tab]>(),
      onUpdated: event<[number, chrome.tabs.OnUpdatedInfo, chrome.tabs.Tab]>(),
      onRemoved: event<[number, chrome.tabs.OnRemovedInfo]>(),
      onAttached: event<[number, chrome.tabs.OnAttachedInfo]>(),
    },
    tabGroups: {
      onCreated: event<[chrome.tabGroups.TabGroup]>(),
      onUpdated: event<[chrome.tabGroups.TabGroup]>(),
      onRemoved: event<[chrome.tabGroups.TabGroup]>(),
      onMoved: event<[chrome.tabGroups.TabGroup]>(),
    },
    windows: { onFocusChanged: event<[number]>(), onRemoved: event<[number]>(), onBoundsChanged: event<[chrome.windows.Window]>() },
    runtime: { onStartup: event<[]>(), onInstalled: event<[]>() },
    commands: { onCommand: event<[string]>() },
    contextMenus: { onClicked: event<[chrome.contextMenus.OnClickData, chrome.tabs.Tab | undefined]>() },
    notifications: { onClicked: event<[string]>() },
    alarms: { onAlarm: event<[]>() },
    storage: { onChanged: event<[Record<string, chrome.storage.StorageChange>, string]>() },
  };

  const mock = {
    tabs: {
      ...events.tabs,
      query: vi.fn(async (info: { windowId?: number; groupId?: number; active?: boolean }) =>
        [...tabs.values()]
          .sort((a, b) => a.windowId - b.windowId || a.position - b.position)
          .filter(
            (tab) =>
              (info.windowId === undefined || tab.windowId === info.windowId) &&
              (info.groupId === undefined || tab.groupId === info.groupId) &&
              (info.active === undefined || tab.active === info.active),
          )
          .map(asTab),
      ),
      get: vi.fn(async (id: number) => (tabs.has(id) ? asTab(tabs.get(id)!) : missing('tab', id))),
      create: vi.fn(async (info: { windowId?: number; url?: string; active?: boolean }) => {
        // Without a window, Chrome uses the focused one; the fake's first window plays that part.
        const windowId = info.windowId ?? [...windows][0] ?? openWindow();
        if (!windows.has(windowId)) return missing('window', windowId);
        return asTab(addTab(windowId, info.url ?? 'chrome://newtab/', info.active ?? true));
      }),
      update: vi.fn(async (id: number, info: { active?: boolean }) => {
        const tab = tabs.get(id);
        if (!tab) return missing('tab', id);
        if (info.active) {
          for (const other of inWindow(tab.windowId)) other.active = false;
          tab.active = true;
          tab.lastAccessed = clock++;
        }
        return asTab(tab);
      }),
      remove: vi.fn(async (ids: number | number[]) => {
        for (const id of [ids].flat()) {
          if (!tabs.has(id)) return missing('tab', id);
          removeTab(id);
        }
      }),
      move: vi.fn(async (id: number, info: { windowId?: number; index: number }) => {
        const tab = tabs.get(id);
        if (!tab) return missing('tab', id);
        if (info.windowId !== undefined && info.windowId !== tab.windowId) {
          tab.windowId = info.windowId;
          tab.position = clock++;
          // Chrome ungroups a tab that leaves its window.
          tab.groupId = NONE;
          pruneGroups();
        }
        return asTab(tab);
      }),
      group: vi.fn(async (info: { tabIds: number | number[]; groupId?: number }) => {
        const ids = [info.tabIds].flat();
        const first = tabs.get(ids[0]!);
        if (!first) return missing('tab', ids[0]!);
        let groupId = info.groupId;
        if (groupId === undefined) {
          groupId = nextId++;
          groups.set(groupId, { id: groupId, windowId: first.windowId, collapsed: false, shared: false, color: 'grey' as chrome.tabGroups.Color });
        } else if (!groups.has(groupId)) return missing('group', groupId);
        for (const id of ids) tabs.get(id)!.groupId = groupId;
        pruneGroups();
        return groupId;
      }),
    },
    tabGroups: {
      ...events.tabGroups,
      TAB_GROUP_ID_NONE: NONE,
      get: vi.fn(async (id: number) => groups.get(id) ?? missing('group', id)),
      move: vi.fn(async (id: number, info: { windowId?: number; index: number }) => {
        const group = groups.get(id);
        if (!group) return missing('group', id);
        const windowId = info.windowId ?? group.windowId;
        if (!windows.has(windowId)) return missing('window', windowId);
        const moving = [...tabs.values()].filter((tab) => tab.groupId === id);
        for (const tab of moving) tab.windowId = windowId;
        group.windowId = windowId;
        const others = inWindow(windowId).filter((tab) => tab.groupId !== id);
        const at = info.index < 0 ? others.length : Math.min(info.index, others.length);
        [...others.slice(0, at), ...moving, ...others.slice(at)].forEach((tab, position) => (tab.position = position));
        return group;
      }),
      query: vi.fn(async (info: { windowId?: number }) =>
        [...groups.values()].filter((group) => info.windowId === undefined || group.windowId === info.windowId),
      ),
      update: vi.fn(async (id: number, info: Partial<FakeGroup>) => {
        const group = groups.get(id);
        if (!group) return missing('group', id);
        Object.assign(group, info);
        return group;
      }),
    },
    windows: {
      ...events.windows,
      WINDOW_ID_NONE: -1,
      getAll: vi.fn(async (info: { populate?: boolean } = {}) =>
        [...windows].map((id) => ({ id, type: 'normal', ...(info.populate ? { tabs: inWindow(id).map(asTab) } : {}) })),
      ),
      getLastFocused: vi.fn(async () => ({ id: [...windows][0] })),
      getCurrent: vi.fn(async () => ({ id: [...windows][0] })),
      remove: vi.fn(async (id: number) => {
        if (!windows.has(id)) return missing('window', id);
        for (const tab of inWindow(id)) tabs.delete(tab.id);
        windows.delete(id);
        pruneGroups();
      }),
      get: vi.fn(async (id: number) => (windows.has(id) ? { id } : missing('window', id))),
      create: vi.fn(async (info: { tabId?: number; url?: string | string[]; focused?: boolean }) => {
        const id = openWindow();
        if (info.tabId !== undefined) {
          const tab = tabs.get(info.tabId);
          if (!tab) return missing('tab', info.tabId);
          const old = tab.windowId;
          tab.windowId = id;
          tab.groupId = NONE;
          if (inWindow(old).length === 0) windows.delete(old);
          pruneGroups();
        } else {
          const urls = [info.url ?? 'chrome://newtab/'].flat();
          urls.forEach((url, index) => addTab(id, url, index === 0));
        }
        return { id };
      }),
      update: vi.fn(async (id: number, info: chrome.windows.UpdateInfo) => {
        if (!windows.has(id)) return missing('window', id);
        if (
          (refuse.positioned && (info.left !== undefined || info.top !== undefined)) ||
          (refuse.sized && (info.width !== undefined || info.height !== undefined))
        ) {
          return Promise.reject(new Error('Bounds must be at least 50% visible on screen.'));
        }
        windowUpdates.push(info);
        return { id };
      }),
    },
    storage: {
      ...events.storage,
      local: storageArea(localStore, (changes) => events.storage.onChanged.emit(changes, 'local')),
      session: storageArea(sessionStore, (changes) => events.storage.onChanged.emit(changes, 'session')),
    },
    runtime: {
      ...events.runtime,
      id: 'ext-id',
      getManifest: vi.fn(() => ({ version: '1.2.3' })),
      reload: vi.fn(),
      sendNativeMessage: vi.fn(async (): Promise<unknown> => ({ ok: true, token: 'token', port: 4000 })),
    },
    sidePanel: { setPanelBehavior: vi.fn(async () => {}), open: vi.fn(async () => {}), close: vi.fn(async () => {}) },
    action: { setBadgeText: vi.fn(async () => {}), setBadgeBackgroundColor: vi.fn(async () => {}) },
    notifications: { ...events.notifications, create: vi.fn(), clear: vi.fn() },
    contextMenus: { ...events.contextMenus, removeAll: vi.fn(async () => {}), create: vi.fn() },
    commands: { ...events.commands, getAll: vi.fn(async (): Promise<{ name: string; shortcut: string }[]> => []) },
    alarms: { ...events.alarms, create: vi.fn() },
  };

  vi.stubGlobal('chrome', mock);

  return {
    mock,
    events,
    refuse,
    windowUpdates,
    /** A window holding one blank tab, as Chrome never has an empty one. */
    addWindow: (url = 'https://example.com/') => {
      const windowId = openWindow();
      const tab = addTab(windowId, url, true);
      return { windowId, tab };
    },
    addTab: (windowId: number, url: string, options: { active?: boolean; groupId?: number } = {}) => {
      const tab = addTab(windowId, url, options.active ?? false);
      if (options.groupId !== undefined) tab.groupId = options.groupId;
      return tab;
    },
    /** A group with the given tabs in it, the first tab's window being the group's. */
    addGroup: (tabIds: number[], options: { title?: string; collapsed?: boolean } = {}) => {
      const id = nextId++;
      groups.set(id, {
        id,
        windowId: tabs.get(tabIds[0]!)!.windowId,
        collapsed: options.collapsed ?? false,
        shared: false,
        color: 'grey' as chrome.tabGroups.Color,
        title: options.title,
      });
      for (const tabId of tabIds) tabs.get(tabId)!.groupId = id;
      return id;
    },
    removeTab,
    removeGroup: (id: number) => {
      for (const tab of tabs.values()) if (tab.groupId === id) tab.groupId = NONE;
      groups.delete(id);
    },
    tab: (id: number) => tabs.get(id),
    group: (id: number) => groups.get(id),
    /** URLs of a window's tabs, in the order they were opened. */
    urls: (windowId: number) => inWindow(windowId).map((tab) => tab.url),
    inGroup: (groupId: number) => [...tabs.values()].filter((tab) => tab.groupId === groupId).map((tab) => tab.url),
    hasWindow: (id: number) => windows.has(id),
    storage: { local: localStore, session: sessionStore },
  };
}

function storageArea(store: Record<string, unknown>, changed: (changes: Record<string, chrome.storage.StorageChange>) => void) {
  return {
    get: vi.fn(async (keys?: string | string[] | Record<string, unknown>) => {
      if (keys === undefined) return { ...store };
      const names = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const defaults = typeof keys === 'object' && !Array.isArray(keys) ? keys : {};
      return Object.fromEntries(names.flatMap((name) => (name in store ? [[name, store[name]]] : name in defaults ? [[name, defaults[name]]] : [])));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      const changes = Object.fromEntries(Object.entries(items).map(([key, newValue]) => [key, { oldValue: store[key], newValue }]));
      Object.assign(store, items);
      changed(changes);
    }),
    remove: vi.fn(async (key: string) => void delete store[key]),
  };
}
