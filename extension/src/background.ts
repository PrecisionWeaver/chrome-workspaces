import { matchWindows, workspaceOrder } from '../../shared/pairing';
import type { ControlToClient, Workspace } from '../../shared/protocol';
import { connectControl } from './helper-client';
import { openWindow, recordSharedSize, switchTo } from './windows';

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

let workspaces: Workspace[] = [];
// `open` can arrive before the `state` that lists the new workspace; those wait for it.
const pendingOpens = new Set<string>();

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
const send = control.send.bind(control);

function find(id: string): Workspace | undefined {
  return workspaces.find((ws) => ws.id === id);
}

function handle(message: ControlToClient): void {
  switch (message.type) {
    case 'state':
      workspaces = message.workspaces;
      void clearStalePairings();
      for (const id of pendingOpens) {
        const workspace = find(id);
        if (!workspace) continue;
        pendingOpens.delete(id);
        void openWindow(workspace, send);
      }
      void repair();
      break;
    case 'open': {
      const workspace = find(message.id);
      if (workspace) void openWindow(workspace, send);
      else pendingOpens.add(message.id);
      break;
    }
    case 'focus': {
      const workspace = find(message.id);
      if (workspace) void switchTo(workspace, send);
      break;
    }
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
  for (const { workspaceId, windowId } of matchWindows(workspaces, open)) send({ type: 'pair', id: workspaceId, windowId });
}

function webUrls(tabs: chrome.tabs.Tab[]): string[] {
  return tabs.flatMap((tab) => (tab.url && /^https?:/.test(tab.url) ? [tab.url] : []));
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'next-workspace') void cycle(1);
  if (command === 'prev-workspace') void cycle(-1);
});

async function cycle(step: 1 | -1): Promise<void> {
  const ordered = workspaceOrder(workspaces);
  if (ordered.length === 0) return;
  const focused = await chrome.windows.getLastFocused();
  const current = ordered.findIndex((ws) => ws.windowId === focused.id);
  const next = current === -1 ? ordered[0] : ordered[(current + step + ordered.length) % ordered.length];
  if (next.id !== ordered[current]?.id) await switchTo(next, send);
}

// Remember each workspace window's tabs so it can be re-paired after Chrome restarts.
const tabTimers = new Map<number, ReturnType<typeof setTimeout>>();

function scheduleTabs(windowId: number): void {
  clearTimeout(tabTimers.get(windowId));
  tabTimers.set(
    windowId,
    setTimeout(() => {
      tabTimers.delete(windowId);
      if (!workspaces.some((ws) => ws.windowId === windowId)) return;
      void chrome.tabs.query({ windowId }).then((tabs) => send({ type: 'tabs', windowId, urls: webUrls(tabs) }));
    }, 1000),
  );
}

chrome.tabs.onCreated.addListener((tab) => scheduleTabs(tab.windowId));
chrome.tabs.onUpdated.addListener((_id, change, tab) => change.url && scheduleTabs(tab.windowId));
chrome.tabs.onRemoved.addListener((_id, info) => !info.isWindowClosing && scheduleTabs(info.windowId));
chrome.tabs.onAttached.addListener((_id, info) => scheduleTabs(info.newWindowId));
chrome.tabs.onDetached.addListener((_id, info) => scheduleTabs(info.oldWindowId));

chrome.windows.onRemoved.addListener((windowId) => send({ type: 'unpair', windowId }));
chrome.windows.onBoundsChanged.addListener(recordSharedSize);

// Wakes the worker if Chrome stopped it while the helper was unreachable; starting reconnects.
chrome.alarms.create('wake', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {});
