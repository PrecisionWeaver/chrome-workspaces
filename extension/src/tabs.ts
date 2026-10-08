import type { Workspace } from '../../shared/protocol';
import { showsPage } from '../../shared/tab-urls';

/** The tab already showing `url` in a tab group, or among a window's tabs that belong to no group. */
export async function findTab(windowId: number, groupId: number | null, url: string): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query(groupId === null ? { windowId } : { groupId });
  return tabs.find((tab) => (groupId !== null || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) && showsPage(tab.url ?? tab.pendingUrl, url));
}

/** Opens `url` in the workspace's tab group, or its window; a page already there is brought forward instead of opened twice. */
export async function openInWorkspace(workspace: Workspace | undefined, currentWindowId: number | undefined, url: string): Promise<void> {
  const windowId = workspace?.windowId ?? currentWindowId;
  if (windowId === undefined) {
    await chrome.tabs.create({ url });
    return;
  }
  const groupId = workspace?.groupId ?? null;
  const existing = await findTab(windowId, groupId, url);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    return;
  }
  const tab = await chrome.tabs.create({ windowId, url, active: true });
  if (groupId === null || tab.id === undefined) return;
  try {
    await chrome.tabs.group({ tabIds: [tab.id], groupId });
  } catch {
    // The group closed in the meantime; the tab stays in the window.
  }
}
