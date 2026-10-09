import { matchGroups, matchWindows } from '../../shared/pairing';
import { attentionEvents, needsInputCount } from '../../shared/attention';
import { listFollowingTabs, listGroupOrder, nextGroupMove } from '../../shared/tab-order';
import type { ControlToClient, Workspace, WorkspaceStatus } from '../../shared/protocol';
import { placeClaudeGroups } from './claude-groups';
import { connectControl } from './helper-client';
import { loadSelection, onSelectionChange, select, shownIn, type Selection } from './selection';
import { createGroup, openWindow, recordSharedSize, switchTo } from './windows';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

let workspaces: Workspace[] = [];
// `open` can arrive before the `state` that lists the new workspace; those wait for it.
const pendingOpens = new Map<string, 'window' | 'group'>();
let selection: Selection = {};
void loadSelection().then((loaded) => (selection = loaded));
onSelectionChange((changed) => (selection = changed));

// Stored window ids go stale when the browser restarts (and may be reused by unrelated windows),
// so the first state after that drops every pairing and re-pairing by tab URLs starts clean.
// chrome.storage.session is also wiped by an extension reload, which keeps window ids, so
// onInstalled rules that case out.
const freshBrowser = new Promise<boolean>((resolve) => {
  chrome.runtime.onStartup.addListener(() => resolve(true));
  chrome.runtime.onInstalled.addListener(() => resolve(false));
  void chrome.storage.session.get('started').then(({ started }) => started && resolve(false));
}).then((fresh) => {
  void chrome.storage.session.set({ started: true });
  return fresh;
});
let staleCleared = false;

const control = connectControl(handle);
const browserCall = placeClaudeGroups(() => workspaces);
const send = control.send.bind(control);

function find(id: string): Workspace | undefined {
  return workspaces.find((ws) => ws.id === id);
}

function handle(message: ControlToClient): void {
  switch (message.type) {
    case 'state': {
      const reordered = previousOrder !== null && previousOrder !== orderKey(message.workspaces);
      previousOrder = orderKey(message.workspaces);
      workspaces = message.workspaces;
      void announce(message.statuses);
      void rebuildSendMenu();
      // The list was reordered, here or in a panel: put the tab groups in the same order.
      if (reordered) void tabsFollowList();
      void clearStalePairings();
      for (const [id, kind] of pendingOpens) {
        const workspace = find(id);
        if (!workspace) continue;
        pendingOpens.delete(id);
        void (kind === 'group' ? createGroup(workspace, send) : openWindow(workspace, send));
      }
      void repair();
      void syncGroupTitles();
      break;
    }
    case 'open': {
      const workspace = find(message.id);
      if (workspace) void openWindow(workspace, send);
      else pendingOpens.set(message.id, 'window');
      break;
    }
    case 'group': {
      const workspace = find(message.id);
      if (workspace) void createGroup(workspace, send);
      else pendingOpens.set(message.id, 'group');
      break;
    }
    case 'focus': {
      const workspace = find(message.id);
      if (workspace) void switchTo(workspace, send, workspaces);
      break;
    }
    case 'sent': {
      const name = find(message.id)?.name ?? 'workspace';
      chrome.notifications.create(`sent-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: message.ok ? `Sent to ${name}` : `Could not send to ${name}`,
        message: message.ok ? 'Pasted into its terminal, not submitted.' : message.message,
      });
      break;
    }
    case 'browser':
      browserCall({ workspaceId: message.id, at: message.at });
      break;
  }
}

async function clearStalePairings(): Promise<void> {
  if (staleCleared || !(await freshBrowser)) return;
  staleCleared = true;
  for (const ws of workspaces) if (ws.windowId !== null) send({ type: 'unpair', windowId: ws.windowId });
}

/** After a Chrome restart window ids change; re-pair workspaces with the windows holding their tabs. */
async function repair(): Promise<void> {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  const open = windows.flatMap((w) => (w.id === undefined ? [] : [{ id: w.id, urls: webUrls(w.tabs ?? []) }]));
  const windowPairs = matchWindows(workspaces, open);
  for (const { workspaceId, windowId } of windowPairs) send({ type: 'pair', id: workspaceId, windowId });

  // A workspace whose window was merged into another as a tab group follows its tabs there.
  const rest = workspaces.filter((ws) => !windowPairs.some((pair) => pair.workspaceId === ws.id));
  const groups = await chrome.tabGroups.query({});
  const tabs = await chrome.tabs.query({});
  const openGroups = groups.map((g) => ({ id: g.id, windowId: g.windowId, urls: webUrls(tabs.filter((t) => t.groupId === g.id)) }));
  for (const { workspaceId, windowId, groupId } of matchGroups(rest, openGroups)) send({ type: 'pair', id: workspaceId, windowId, groupId });
}

/** A renamed workspace renames its tab group. */
async function syncGroupTitles(): Promise<void> {
  for (const ws of workspaces) {
    if (ws.groupId === null) continue;
    try {
      const group = await chrome.tabGroups.get(ws.groupId);
      if (group.title !== ws.name) await chrome.tabGroups.update(ws.groupId, { title: ws.name });
    } catch {
      // The group closed; its removal unpairs it.
    }
  }
}

function webUrls(tabs: chrome.tabs.Tab[]): string[] {
  return tabs.flatMap((tab) => (tab.url && /^https?:/.test(tab.url) ? [tab.url] : []));
}

// Tracked as it changes so a shortcut can pick the next workspace without awaiting: opening the
// side panel only works synchronously inside the shortcut's user gesture.
let focusedWindowId: number | undefined;
void chrome.windows.getLastFocused().then((win) => (focusedWindowId ??= win.id));
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) focusedWindowId = windowId;
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'next-workspace') cycle(1);
  if (command === 'prev-workspace') cycle(-1);
});

function cycle(step: 1 | -1): void {
  // Archived workspaces are tucked away, so the shortcuts skip them.
  const list = workspaces.filter((ws) => !ws.archived);
  if (list.length === 0) return;
  const shown = shownIn(focusedWindowId, workspaces, selection);
  const current = list.findIndex((ws) => ws.id === shown?.id);
  const next = current === -1 ? list[0] : list[(current + step + list.length) % list.length];
  if (next.id === list[current]?.id) return;
  // Reopens the panel in a window whose panel closed, e.g. after the extension reloaded.
  if (next.windowId !== null) chrome.sidePanel.open({ windowId: next.windowId }).catch(() => {});
  void select(next);
  void switchTo(next, send, workspaces);
}

// Remember each workspace window's tabs so it can be re-paired after Chrome restarts.
const tabTimers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleTabs(windowId: number): void {
  clearTimeout(tabTimers.get(windowId));
  tabTimers.set(
    windowId,
    setTimeout(() => {
      tabTimers.delete(windowId);
      const here = workspaces.filter((ws) => ws.windowId === windowId);
      if (here.length === 0) return;
      void chrome.tabs.query({ windowId }).then((tabs) => {
        const grouped = new Set(here.flatMap((ws) => (ws.groupId === null ? [] : [ws.groupId])));
        for (const ws of here) {
          // A workspace without a group of its own keeps the tabs that no group in the window claims.
          const mine = ws.groupId === null ? tabs.filter((tab) => !grouped.has(tab.groupId)) : tabs.filter((tab) => tab.groupId === ws.groupId);
          // An emptied window is about to close; its last tabs are what re-pair the workspace.
          if (mine.length === 0) continue;
          send({ type: 'tabs', windowId, urls: webUrls(mine), ...(ws.groupId === null ? {} : { groupId: ws.groupId }) });
        }
      });
    }, 1000),
  );
}

chrome.tabs.onCreated.addListener((tab) => scheduleTabs(tab.windowId));
chrome.tabs.onUpdated.addListener((_id, change, tab) => (change.url || change.groupId !== undefined) && scheduleTabs(tab.windowId));
chrome.tabs.onRemoved.addListener((_id, info) => !info.isWindowClosing && scheduleTabs(info.windowId));
chrome.tabs.onAttached.addListener((_id, info) => scheduleTabs(info.newWindowId));
chrome.tabGroups.onRemoved.addListener((group) => send({ type: 'unpairGroup', groupId: group.id }));

// ---- right-click: send a selection, link or page to a workspace's terminal ----

const SEND_PARENT = 'send-to-workspace';
const MAX_MENU_WORKSPACES = 20;
let sendMenuKey = '';
let sendMenuBuild: Promise<void> = Promise.resolve();

/** Rebuilds the right-click menu when the workspaces it lists change. */
function rebuildSendMenu(): Promise<void> {
  const listed = workspaces.filter((ws) => !ws.archived).slice(0, MAX_MENU_WORKSPACES);
  const key = listed.map((ws) => `${ws.id}:${ws.name}`).join('|');
  if (key === sendMenuKey) return sendMenuBuild;
  sendMenuKey = key;
  // One build at a time: removeAll and create are asynchronous and would interleave.
  sendMenuBuild = sendMenuBuild.then(async () => {
    await chrome.contextMenus.removeAll();
    if (listed.length === 0) return;
    const contexts: ['selection', 'link', 'page'] = ['selection', 'link', 'page'];
    chrome.contextMenus.create({ id: SEND_PARENT, title: 'Send to workspace', contexts });
    for (const ws of listed) chrome.contextMenus.create({ id: `send:${ws.id}`, parentId: SEND_PARENT, title: ws.name, contexts });
  });
  return sendMenuBuild;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId);
  if (!id.startsWith('send:')) return;
  // What was right-clicked: selected text, else the link, else the page.
  const text = info.selectionText?.trim() || info.linkUrl || [tab?.title, info.pageUrl ?? tab?.url].filter(Boolean).join('\n');
  if (text) send({ type: 'sendText', id: id.slice('send:'.length), text });
});

// ---- attention: the toolbar badge and optional notifications ----

let previousStatuses: Record<string, WorkspaceStatus> | null = null;

async function notificationsOn(): Promise<boolean> {
  const { prefs } = (await chrome.storage.local.get('prefs')) as { prefs?: { notify?: boolean } };
  return prefs?.notify === true;
}

/** Shows how many workspaces wait on the user, and notifies when one starts waiting or finishes. */
async function announce(statuses: Record<string, WorkspaceStatus>): Promise<void> {
  const waiting = needsInputCount(statuses, workspaces.map((ws) => ws.id));
  await chrome.action.setBadgeText({ text: waiting ? String(waiting) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#f26d6d' });
  const events = previousStatuses ? attentionEvents(previousStatuses, statuses) : [];
  previousStatuses = statuses;
  if (events.length === 0 || !(await notificationsOn())) return;
  for (const event of events) {
    const workspace = find(event.id);
    if (!workspace) continue;
    chrome.notifications.create(`ws-${event.id}`, {
      type: 'basic',
      iconUrl: 'icons/icon-128.png',
      title: event.kind === 'needs_input' ? `${workspace.name} needs your input` : `${workspace.name} finished`,
      message: event.kind === 'needs_input' ? 'Claude is waiting for you.' : 'Claude is idle again.',
      priority: 1,
    });
  }
}

chrome.notifications.onClicked.addListener((notificationId) => {
  const workspace = find(notificationId.replace(/^ws-/, ''));
  chrome.notifications.clear(notificationId);
  if (workspace) void switchTo(workspace, send, workspaces);
});

// ---- order: the panel's list and the tab strip stay in step ----

const orderKey = (list: readonly Workspace[]): string => list.map((ws) => ws.id).join(',');
// The order of the last state, to tell a reorder from any other change.
let previousOrder: string | null = null;
// Moves the worker makes itself fire the same events as a drag, so they are not read back as one.
let ignoreMovesUntil = 0;
let applying = false;

/** Every tab group in a window, left to right. */
async function stripOrder(windowId: number): Promise<number[]> {
  const tabs = await chrome.tabs.query({ windowId });
  const groups: number[] = [];
  for (const tab of [...tabs].sort((a, b) => a.index - b.index)) {
    if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && !groups.includes(tab.groupId)) groups.push(tab.groupId);
  }
  return groups;
}

/** Moves each window's tab groups into the order its workspaces have in the list. */
async function tabsFollowList(): Promise<void> {
  if (applying) return;
  applying = true;
  try {
    for (const windowId of new Set(workspaces.flatMap((ws) => (ws.windowId !== null && ws.groupId !== null ? [ws.windowId] : [])))) {
      const desired = listGroupOrder(workspaces, windowId);
      if (desired.length < 2) continue;
      // Each move puts one group in place, so a window needs at most as many moves as it has groups.
      for (let step = 0; step < desired.length; step++) {
        const strip = await stripOrder(windowId).catch(() => null);
        const move = strip && nextGroupMove(strip, desired);
        if (!move) break;
        try {
          const tabs = await chrome.tabs.query({ windowId });
          const target = tabs.filter((tab) => tab.groupId === move.before).sort((a, b) => a.index - b.index)[0];
          if (!target) break;
          await chrome.tabGroups.move(move.groupId, { index: target.index });
        } catch {
          // A group closed mid-move; the next change brings them back in step.
          break;
        }
      }
    }
  } finally {
    ignoreMovesUntil = Date.now() + 1000;
    applying = false;
  }
}

/** A group was dragged in the tab strip: put its window's workspaces in the same order in the list. */
async function listFollowsTabs(windowId: number): Promise<void> {
  const strip = await stripOrder(windowId).catch(() => null);
  if (!strip) return;
  const ids = listFollowingTabs(workspaces, windowId, strip);
  if (ids) send({ type: 'order', ids });
}

let orderTimer: ReturnType<typeof setTimeout> | undefined;
chrome.tabGroups.onMoved.addListener((group) => {
  if (applying || Date.now() < ignoreMovesUntil) return;
  // A drag reports every step it passes; wait for it to settle.
  clearTimeout(orderTimer);
  orderTimer = setTimeout(() => void listFollowsTabs(group.windowId), 400);
});

// A group made or moved by hand can be the new home of a workspace whose window closed.
let repairTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRepair(): void {
  clearTimeout(repairTimer);
  repairTimer = setTimeout(() => void repair(), 1500);
}
chrome.tabGroups.onCreated.addListener(scheduleRepair);
chrome.tabGroups.onUpdated.addListener(scheduleRepair);
chrome.windows.onRemoved.addListener(scheduleRepair);

chrome.windows.onRemoved.addListener((windowId) => send({ type: 'unpair', windowId }));
chrome.windows.onBoundsChanged.addListener(recordSharedSize);

// Wakes the worker if Chrome stopped it while the helper was unreachable; starting reconnects.
chrome.alarms.create('wake', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {});
