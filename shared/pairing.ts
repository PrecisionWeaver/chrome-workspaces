import type { Workspace } from './protocol';

export interface OpenWindow {
  id: number;
  urls: string[];
}

export interface Pairing {
  workspaceId: string;
  windowId: number;
}

export function similarity(a: readonly string[], b: readonly string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  let shared = 0;
  for (const url of left) if (right.has(url)) shared++;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Pairs workspaces that have lost their window (e.g. after a Chrome restart, which reissues
 * window ids) with open windows holding similar tabs. Closest matches are taken first, and a
 * window already paired to a workspace is never reassigned.
 */
export function matchWindows(workspaces: readonly Workspace[], windows: readonly OpenWindow[], threshold = 0.5): Pairing[] {
  const openIds = new Set(windows.map((w) => w.id));
  const taken = new Set(workspaces.flatMap((ws) => (ws.windowId !== null && openIds.has(ws.windowId) ? [ws.windowId] : [])));
  const orphans = workspaces.filter((ws) => (ws.windowId === null || !openIds.has(ws.windowId)) && ws.lastTabUrls.length > 0);

  const candidates: (Pairing & { score: number })[] = [];
  for (const ws of orphans) {
    for (const win of windows) {
      if (taken.has(win.id)) continue;
      const score = similarity(ws.lastTabUrls, win.urls);
      if (score >= threshold) candidates.push({ workspaceId: ws.id, windowId: win.id, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const paired = new Set<string>();
  const result: Pairing[] = [];
  for (const { workspaceId, windowId } of candidates) {
    if (paired.has(workspaceId) || taken.has(windowId)) continue;
    paired.add(workspaceId);
    taken.add(windowId);
    result.push({ workspaceId, windowId });
  }
  return result;
}

export interface OpenGroup {
  id: number;
  windowId: number;
  urls: string[];
}

export interface GroupPairing {
  workspaceId: string;
  windowId: number;
  groupId: number;
}

/**
 * Pairs workspaces without a window, e.g. one whose window was merged into another as a tab
 * group, with the open group holding the same tabs. The pairing carries the group's window.
 */
export function matchGroups(workspaces: readonly Workspace[], groups: readonly OpenGroup[], threshold = 0.5): GroupPairing[] {
  const openIds = new Set(groups.map((g) => g.id));
  const taken = new Set(workspaces.flatMap((ws) => (ws.groupId !== null && openIds.has(ws.groupId) ? [ws.groupId] : [])));
  const orphans = workspaces.filter((ws) => ws.windowId === null && ws.lastTabUrls.length > 0);

  const candidates: (GroupPairing & { score: number })[] = [];
  for (const ws of orphans) {
    for (const group of groups) {
      if (taken.has(group.id)) continue;
      const score = similarity(ws.lastTabUrls, group.urls);
      if (score >= threshold) candidates.push({ workspaceId: ws.id, windowId: group.windowId, groupId: group.id, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);

  const paired = new Set<string>();
  const result: GroupPairing[] = [];
  for (const { workspaceId, windowId, groupId } of candidates) {
    if (paired.has(workspaceId) || taken.has(groupId)) continue;
    paired.add(workspaceId);
    taken.add(groupId);
    result.push({ workspaceId, windowId, groupId });
  }
  return result;
}
