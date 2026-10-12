import type { ControlToHelper, Workspace } from '../../shared/protocol';
import { showsPage } from '../../shared/tab-urls';
import { takeReviewTab } from './tabs';

type Bounds = Pick<chrome.windows.Window, 'left' | 'top' | 'width' | 'height'>;
type SharedSize = { maximized: true } | Bounds;

/** Whichever workspace window was last moved, resized or maximized sets the size new windows open at. */
export function recordSharedSize(window: chrome.windows.Window): void {
  if (window.type !== 'normal') return;
  let sharedSize: SharedSize;
  if (window.state === 'maximized') sharedSize = { maximized: true };
  else if (window.state === 'normal') sharedSize = { left: window.left, top: window.top, width: window.width, height: window.height };
  else return;
  // Stored rather than held in memory because the service worker can be stopped at any time.
  void chrome.storage.local.set({ sharedSize });
}

async function sizeOptions(): Promise<chrome.windows.UpdateInfo> {
  const { sharedSize } = (await chrome.storage.local.get('sharedSize')) as { sharedSize?: SharedSize };
  if (!sharedSize) return {};
  return 'maximized' in sharedSize ? { state: 'maximized' } : { state: 'normal', ...sharedSize };
}

/**
 * Chrome rejects bounds that are mostly off screen, e.g. a shared position recorded on a display
 * that has since been disconnected. Then the size alone is kept, and failing that, nothing.
 */
async function updateWindow(windowId: number, options: chrome.windows.UpdateInfo): Promise<void> {
  const { left, top, ...sizeOnly } = options;
  const { width, height, state, ...rest } = sizeOnly;
  for (const attempt of [options, sizeOnly, rest]) {
    try {
      await chrome.windows.update(windowId, attempt);
      return;
    } catch {
      // Falls through to the next, smaller attempt.
    }
  }
}

async function windowExists(windowId: number): Promise<boolean> {
  try {
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

/** Brings the workspace's window forward as sized, and its tab group if it has one, opening a window if it has none. Returns its window id. */
export async function switchTo(
  workspace: Workspace,
  send: (message: ControlToHelper) => boolean,
  all: readonly Workspace[] = [workspace],
): Promise<number | undefined> {
  if (workspace.windowId !== null && (await windowExists(workspace.windowId))) {
    await chrome.windows.update(workspace.windowId, { focused: true });
    if (workspace.groupId !== null) await focusGroup(workspace.groupId);
    if (all.some((other) => other.id !== workspace.id && other.windowId === workspace.windowId)) await showOnly(workspace.windowId, workspace.groupId);
    return workspace.windowId;
  }
  return openWindow(workspace, send);
}

export async function openWindow(workspace: Workspace, send: (message: ControlToHelper) => boolean): Promise<number | undefined> {
  const size = await sizeOptions();
  const urls = workspace.lastTabUrls.length ? workspace.lastTabUrls : workspace.url ? [workspace.url] : [];
  // The PR tab its review request opened leads the new window, in place of a second copy.
  const taken = await takeReviewTab(workspace.pr);
  const rest = taken ? urls.filter((url) => !showsPage(url, workspace.pr!)) : urls;
  const created = await chrome.windows.create(taken ? { tabId: taken.id, focused: true } : { url: urls.length ? urls : undefined, focused: true });
  if (created?.id === undefined) return undefined;
  if (taken) for (const url of rest) await chrome.tabs.create({ windowId: created.id, url, active: false });
  await updateWindow(created.id, size);
  send({ type: 'pair', id: workspace.id, windowId: created.id });
  return created.id;
}

/** Expands the group and activates the tab last used in it. */
async function focusGroup(groupId: number): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ groupId });
    const tab = tabs.find((t) => t.active) ?? [...tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    await chrome.tabGroups.update(groupId, { collapsed: false });
    if (tab?.id !== undefined) await chrome.tabs.update(tab.id, { active: true });
  } catch {
    // The group closed; its removal unpairs it.
  }
}

/** Opens the workspace's tabs as a titled tab group in its window. */
export async function createGroup(workspace: Workspace, send: (message: ControlToHelper) => boolean): Promise<void> {
  if (workspace.windowId === null || !(await windowExists(workspace.windowId))) return;
  const urls: (string | undefined)[] = workspace.lastTabUrls.length ? workspace.lastTabUrls : [workspace.url ?? undefined];
  // The PR tab its review request opened, often in the group next door, moves in rather than staying behind as a duplicate.
  let taken = await takeReviewTab(workspace.pr);
  const tabIds: number[] = [];
  for (const [index, url] of urls.entries()) {
    if (taken?.id !== undefined && url && showsPage(url, workspace.pr!)) {
      await chrome.tabs.move(taken.id, { windowId: workspace.windowId, index: -1 });
      if (index === 0) await chrome.tabs.update(taken.id, { active: true });
      tabIds.push(taken.id);
      taken = undefined;
      continue;
    }
    const tab = await chrome.tabs.create({ windowId: workspace.windowId, url, active: index === 0 });
    if (tab.id !== undefined) tabIds.push(tab.id);
  }
  if (tabIds.length === 0) return;
  const groupId = await chrome.tabs.group({ tabIds: tabIds as [number, ...number[]] });
  await chrome.tabGroups.update(groupId, {
    title: workspace.name,
    collapsed: false,
    ...(workspace.color ? { color: workspace.color as chrome.tabGroups.Color } : {}),
  });
  send({ type: 'pair', id: workspace.id, windowId: workspace.windowId, groupId });
  await showOnly(workspace.windowId, groupId);
}

/**
 * Collapses every tab group in the window but the workspace's own, so a shared window shows one
 * workspace at a time. Groups can be expanded again by hand; this runs when the workspace changes.
 * A workspace with no group stays on a tab outside the groups, and nothing collapses if there is none.
 */
export async function showOnly(windowId: number, groupId: number | null): Promise<void> {
  try {
    if (groupId === null) {
      const tabs = await chrome.tabs.query({ windowId });
      if (tabs.some((tab) => tab.active && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE)) {
        const ungrouped = tabs
          .filter((tab) => tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE)
          .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
        if (ungrouped?.id === undefined) return;
        await chrome.tabs.update(ungrouped.id, { active: true });
      }
    }
    for (const group of await chrome.tabGroups.query({ windowId })) {
      if (group.id !== groupId && !group.collapsed) await chrome.tabGroups.update(group.id, { collapsed: true });
    }
  } catch {
    // A group or tab closed mid-way; the next switch tidies up.
  }
}
