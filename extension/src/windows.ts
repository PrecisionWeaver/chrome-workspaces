import type { ControlToHelper, Workspace } from '../../shared/protocol';

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
export async function switchTo(workspace: Workspace, send: (message: ControlToHelper) => boolean): Promise<number | undefined> {
  if (workspace.windowId !== null && (await windowExists(workspace.windowId))) {
    await chrome.windows.update(workspace.windowId, { focused: true });
    if (workspace.groupId !== null) await focusGroup(workspace.groupId);
    return workspace.windowId;
  }
  return openWindow(workspace, send);
}

export async function openWindow(workspace: Workspace, send: (message: ControlToHelper) => boolean): Promise<number | undefined> {
  const size = await sizeOptions();
  const created = await chrome.windows.create({
    url: workspace.lastTabUrls.length ? workspace.lastTabUrls : (workspace.url ?? undefined),
    focused: true,
  });
  if (created?.id === undefined) return undefined;
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

/** Opens the workspace's first tab as a titled tab group in its window. */
export async function createGroup(workspace: Workspace, send: (message: ControlToHelper) => boolean): Promise<void> {
  if (workspace.windowId === null || !(await windowExists(workspace.windowId))) return;
  const tab = await chrome.tabs.create({ windowId: workspace.windowId, url: workspace.url ?? undefined, active: true });
  if (tab.id === undefined) return;
  const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
  await chrome.tabGroups.update(groupId, { title: workspace.name, collapsed: false });
  send({ type: 'pair', id: workspace.id, windowId: workspace.windowId, groupId });
}
