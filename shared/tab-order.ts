import type { Workspace } from './protocol';

// Workspaces that have a tab group in a window are listed in the panel in the same relative order
// as their groups sit in that window's tab strip. These keep the two in step, in either direction.

/** The tab groups of a window's workspaces, in the order the panel lists them. */
export function listGroupOrder(workspaces: readonly Workspace[], windowId: number): number[] {
  return workspaces.flatMap((ws) => (ws.windowId === windowId && ws.groupId !== null ? [ws.groupId] : []));
}

/**
 * The workspace list reordered to match the tab strip, or null when it already does. `stripGroups` is
 * every tab group in the window, left to right; groups that belong to no workspace are ignored. Only
 * the slots the window's workspaces occupy change, so every other workspace stays where it is.
 */
export function listFollowingTabs(workspaces: readonly Workspace[], windowId: number, stripGroups: readonly number[]): string[] | null {
  const mine = workspaces.filter((ws) => ws.windowId === windowId && ws.groupId !== null);
  if (mine.length < 2) return null;
  const byGroup = new Map(mine.map((ws) => [ws.groupId as number, ws]));
  const ordered = stripGroups.flatMap((id) => (byGroup.has(id) ? [byGroup.get(id)!] : []));
  // A workspace whose group is not in the strip (it just closed) cannot be placed.
  if (ordered.length !== mine.length) return null;
  const slots = workspaces.flatMap((ws, index) => (byGroup.get(ws.groupId as number) === ws ? [index] : []));
  const ids = workspaces.map((ws) => ws.id);
  const next = [...ids];
  slots.forEach((slot, i) => (next[slot] = ordered[i].id));
  return next.every((id, i) => id === ids[i]) ? null : next;
}

/**
 * The next move that brings the tab strip's groups into the panel's order: put `groupId` just before
 * `before`. Null when the workspaces' groups are already in order. Other groups in the strip are left alone.
 */
export function nextGroupMove(stripGroups: readonly number[], desired: readonly number[]): { groupId: number; before: number } | null {
  const wanted = new Set(desired);
  const current = stripGroups.filter((id) => wanted.has(id));
  // A group that is not in the strip cannot be moved.
  const order = desired.filter((id) => current.includes(id));
  for (let i = 0; i < order.length; i++) {
    if (current[i] !== order[i]) return { groupId: order[i], before: current[i] };
  }
  return null;
}
