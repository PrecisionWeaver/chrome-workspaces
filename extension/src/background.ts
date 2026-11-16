import { matchGroups, matchWindows } from '../../shared/workspaces/pairing';
import type { ControlToClient, Workspace } from '../../shared/protocol/protocol';
import { installAttention } from './background/attention';
import { placeClaudeGroups } from './background/claude-groups';
import { installOrderSync } from './background/order-sync';
import { installSendMenu } from './background/send-menu';
import { connectControl } from './app/helper-client';
import { loadSelection, onSelectionChange, select, shownIn, type Selection } from './background/selection';
import { createGroup, openWindow, recordSharedSize, switchTo } from './background/windows';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

let workspaces: Workspace[] = [];
/** What `repair` and `syncGroupTitles` read from the workspaces: who they are, where they are paired, and what their tabs were. */
const pairingKey = (list: readonly Workspace[]): string =>
  list.map((ws) => `${ws.id}\t${ws.name}\t${ws.windowId}\t${ws.groupId}\t${ws.lastTabUrls.join(' ')}`).join('\n');
let previousPairing: string | null = null;
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
const sendMenu = installSendMenu({ workspaces: () => workspaces, send });
const attention = installAttention({ workspaces: () => workspaces, open: (workspace) => void switchTo(workspace, send, workspaces) });
const orderSync = installOrderSync({ workspaces: () => workspaces, send });

function find(id: string): Workspace | undefined {
  return workspaces.find((ws) => ws.id === id);
}

function handle(message: ControlToClient): void {
  switch (message.type) {
    case 'state': {
      workspaces = message.workspaces;
      void attention.announce(message.statuses, message.waiting);
      void sendMenu.rebuild();
      orderSync.noteState(message.workspaces);
      void clearStalePairings();
      for (const [id, kind] of pendingOpens) {
        const workspace = find(id);
        if (!workspace) continue;
        pendingOpens.delete(id);
        void (kind === 'group' ? createGroup(workspace, send) : openWindow(workspace, send));
      }
      // `state` comes with every status change in every session; Chrome is only swept when what pairing and titles use has changed.
      const pairing = pairingKey(message.workspaces);
      if (pairing !== previousPairing) {
        previousPairing = pairing;
        void repair();
        void syncGroupTitles();
      }
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
    case 'closeTabs':
      void closeTabs(message.windowId, message.groupId);
      break;
    case 'sent':
      attention.notifySent(message);
      break;
    case 'browser':
      browserCall({ workspaceId: message.id, at: message.at });
      break;
  }
}

/** A group's tabs close, and Chrome closes the window with the last of them; without a group the whole window goes. */
async function closeTabs(windowId: number, groupId: number | null): Promise<void> {
  try {
    if (groupId === null) {
      await chrome.windows.remove(windowId);
      return;
    }
    const tabs = await chrome.tabs.query({ groupId });
    const ids = tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]));
    if (ids.length) await chrome.tabs.remove(ids);
  } catch {
    // Already closed by hand.
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
  const list = workspaces;
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
