import type { Workspace } from '../../shared/protocol';
import { showsPage } from '../../shared/tab-urls';

/** The tab already showing `url` in a tab group, or among a window's tabs that belong to no group. */
export async function findTab(windowId: number, groupId: number | null, url: string): Promise<chrome.tabs.Tab | undefined> {
  const tabs = await chrome.tabs.query(groupId === null ? { windowId } : { groupId });
  return tabs.find((tab) => (groupId !== null || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) && showsPage(tab.url ?? tab.pendingUrl, url));
}

/**
 * Opens `url` in the workspace's tab group, or its window; a page already there is brought forward instead of opened twice.
 * Resolves to the id of a newly opened tab, or undefined when an existing one was reused.
 */
export async function openInWorkspace(workspace: Workspace | undefined, currentWindowId: number | undefined, url: string): Promise<number | undefined> {
  const windowId = workspace?.windowId ?? currentWindowId;
  if (windowId === undefined) return (await chrome.tabs.create({ url })).id;
  const groupId = workspace?.groupId ?? null;
  const existing = await findTab(windowId, groupId, url);
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true });
    return undefined;
  }
  const tab = await chrome.tabs.create({ windowId, url, active: true });
  if (groupId === null || tab.id === undefined) return tab.id;
  try {
    await chrome.tabs.group({ tabIds: [tab.id], groupId });
  } catch {
    // The group closed in the meantime; the tab stays in the window.
  }
  return tab.id;
}

/**
 * Remembers the PR tab a review request opened, so the workspace made for that PR takes it rather
 * than leaving it behind in the workspace it was opened from. Stored because the service worker,
 * which opens the new workspace's tabs, is not the panel.
 */
export async function noteReviewTab(url: string, tabId: number): Promise<void> {
  await chrome.storage.session.set({ reviewTab: { url, tabId } });
}

/** The noted tab for `url`, if it still shows that page and is not the last tab in its window, which moving would close. */
export async function takeReviewTab(url: string | null): Promise<chrome.tabs.Tab | undefined> {
  if (!url) return undefined;
  const { reviewTab } = (await chrome.storage.session.get('reviewTab')) as { reviewTab?: { url: string; tabId: number } };
  if (reviewTab?.url !== url) return undefined;
  await chrome.storage.session.remove('reviewTab');
  try {
    const tab = await chrome.tabs.get(reviewTab.tabId);
    if (!showsPage(tab.url ?? tab.pendingUrl, url)) return undefined;
    const siblings = await chrome.tabs.query({ windowId: tab.windowId });
    return siblings.length > 1 ? tab : undefined;
  } catch {
    return undefined;
  }
}
