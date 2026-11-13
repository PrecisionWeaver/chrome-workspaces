import type { HistoryEntry, ReviewsState, WaitingOn, Workspace, WorkspaceStatus } from '../../../shared/protocol/protocol';
import { select, shownIn, type Selection } from '../background/selection';
import { showOnly } from '../background/windows';

/** What the panel knows from the helper and from Chrome. Views read it through this object, so there is one copy. */
export interface PanelState {
  /** The window this panel is in, once Chrome has said which. */
  windowId: number | undefined;
  workspaces: Workspace[];
  statuses: Record<string, WorkspaceStatus>;
  waiting: Record<string, WaitingOn>;
  reviews: ReviewsState;
  history: HistoryEntry[];
  /** The Jira site from the config, learned from the system snapshot; null hides every ticket link. */
  jiraBase: string | null;
  /** Which workspace this window shows when it holds several; chosen from the list, or by the tab being worked in. */
  selection: Selection;
  /** The workspace this window shows, if it has one. */
  current(): Workspace | undefined;
  /** A workspace that has just joined this window, by being created or paired here, is the one to show. */
  selectJoiners(next: readonly Workspace[]): void;
  /** Working in a tab that belongs to a workspace's group switches to that workspace. */
  followActiveTab(): Promise<void>;
}

export function createPanelState(): PanelState {
  // Where each workspace was in the previous state, to notice one arriving in this window.
  let previousWindows: Map<string, number | null> | null = null;

  const state: PanelState = {
    windowId: undefined,
    workspaces: [],
    statuses: {},
    waiting: {},
    reviews: { items: [], error: null, fetchedAt: null, refreshing: false },
    history: [],
    jiraBase: null,
    selection: {},
    current() {
      return shownIn(state.windowId, state.workspaces, state.selection);
    },
    selectJoiners(next) {
      const { windowId } = state;
      if (previousWindows && windowId !== undefined) {
        const joined = next.find((ws) => ws.windowId === windowId && previousWindows!.get(ws.id) !== windowId);
        if (joined) void select(joined);
      }
      previousWindows = new Map(next.map((ws) => [ws.id, ws.windowId]));
    },
    async followActiveTab() {
      const { windowId } = state;
      if (windowId === undefined) return;
      const [tab] = await chrome.tabs.query({ active: true, windowId });
      const owner = state.workspaces.find((ws) => ws.windowId === windowId && ws.groupId !== null && ws.groupId === tab?.groupId);
      if (!owner || owner.id === state.current()?.id) return;
      void select(owner);
      void showOnly(owner.windowId!, owner.groupId);
    },
  };
  return state;
}
