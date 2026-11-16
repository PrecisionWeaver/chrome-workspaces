import { listFollowingTabs, listGroupOrder, nextGroupMove } from '../../../shared/workspaces/tab-order';
import type { ControlToHelper, Workspace } from '../../../shared/protocol/protocol';

export interface OrderSyncDeps {
  workspaces(): readonly Workspace[];
  send(message: ControlToHelper): boolean;
}

const orderKey = (list: readonly Workspace[]): string => list.map((ws) => ws.id).join(',');

/** Every tab group in a window, left to right. */
async function stripOrder(windowId: number): Promise<number[]> {
  const tabs = await chrome.tabs.query({ windowId });
  const groups: number[] = [];
  for (const tab of [...tabs].sort((a, b) => a.index - b.index)) {
    if (tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE && !groups.includes(tab.groupId)) groups.push(tab.groupId);
  }
  return groups;
}

/**
 * The panel's list and the tab strip stay in step: a reordered list moves the tab groups, and a group dragged in the
 * strip reorders the list. `noteState` is given every state, to tell a reorder from any other change.
 */
export function installOrderSync({ workspaces, send }: OrderSyncDeps): { noteState(list: readonly Workspace[]): void } {
  // The order of the last state, to tell a reorder from any other change.
  let previousOrder: string | null = null;
  // Moves the worker makes itself fire the same events as a drag, so they are not read back as one.
  let ignoreMovesUntil = 0;
  let applying = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Moves each window's tab groups into the order its workspaces have in the list. */
  async function tabsFollowList(): Promise<void> {
    if (applying) return;
    applying = true;
    try {
      const list = workspaces();
      for (const windowId of new Set(list.flatMap((ws) => (ws.windowId !== null && ws.groupId !== null ? [ws.windowId] : [])))) {
        const desired = listGroupOrder(list, windowId);
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
    const ids = listFollowingTabs(workspaces(), windowId, strip);
    if (ids) send({ type: 'order', ids });
  }

  chrome.tabGroups.onMoved.addListener((group) => {
    if (applying || Date.now() < ignoreMovesUntil) return;
    // A drag reports every step it passes; wait for it to settle.
    clearTimeout(timer);
    timer = setTimeout(() => void listFollowsTabs(group.windowId), 400);
  });

  return {
    noteState(list) {
      const reordered = previousOrder !== null && previousOrder !== orderKey(list);
      previousOrder = orderKey(list);
      // The list was reordered, here or in a panel: put the tab groups in the same order.
      if (reordered) void tabsFollowList();
    },
  };
}
