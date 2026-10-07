import { CALL_WINDOW_MS, CLAUDE_GROUP_TITLE, groupOwner, type BrowserCall } from '../../shared/claude-groups';
import type { Workspace } from '../../shared/protocol';

// Claude groups waiting for the browser call that opened them, by group id → when first seen.
const unplaced = new Map<number, number>();
// Groups already queued; their titles keep changing (status emoji), and a group the user later
// drags elsewhere stays where they put it.
const seen = new Set<number>();
let calls: BrowserCall[] = [];

/** Moves each new Claude in Chrome tab group into the window of the workspace that opened it. Returns the browser-call sink. */
export function placeClaudeGroups(workspaces: () => readonly Workspace[]): (call: BrowserCall) => void {
  const consider = (group: chrome.tabGroups.TabGroup): void => {
    if (seen.has(group.id) || !CLAUDE_GROUP_TITLE.test(group.title ?? '')) return;
    seen.add(group.id);
    unplaced.set(group.id, Date.now());
    void place(workspaces());
  };
  chrome.tabGroups.onCreated.addListener(consider);
  chrome.tabGroups.onUpdated.addListener(consider);
  chrome.tabGroups.onRemoved.addListener((group) => {
    unplaced.delete(group.id);
    seen.delete(group.id);
  });

  return (call) => {
    calls.push(call);
    void place(workspaces());
  };
}

async function place(workspaces: readonly Workspace[]): Promise<void> {
  const now = Date.now();
  calls = calls.filter((call) => now - call.at <= 2 * CALL_WINDOW_MS);
  for (const [groupId, seenAt] of unplaced) {
    const owner = groupOwner(seenAt, calls);
    if (owner === null) {
      if (now - seenAt > CALL_WINDOW_MS) unplaced.delete(groupId);
      continue;
    }
    unplaced.delete(groupId);
    const windowId = workspaces.find((ws) => ws.id === owner)?.windowId;
    if (windowId == null) continue;
    try {
      const group = await chrome.tabGroups.get(groupId);
      if (group.windowId !== windowId) await chrome.tabGroups.move(groupId, { windowId, index: -1 });
    } catch (error) {
      // The group was closed, or the workspace's window went away.
      console.warn('could not move Claude tab group', error);
    }
  }
}
