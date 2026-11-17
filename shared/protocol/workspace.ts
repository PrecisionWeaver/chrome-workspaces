// What a workspace is, as the helper stores it and the panel lists it. Shared by the helper and the extension bundle — keep this free of Node imports.

/** Colors a workspace can be marked with; the names Chrome uses for tab groups. */
export const WORKSPACE_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;

export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

/** A removed workspace, kept so it can be restored. */
export interface HistoryEntry {
  id: string;
  name: string;
  cwd: string;
  ticket: string | null;
  url: string | null;
  pr: string | null;
  model: string | null;
  tabs: string[];
  pinned: boolean;
  color: WorkspaceColor | null;
  /** Its claude session, resumed when restored. */
  resumeId: string | null;
  /** The id the workspace had, which its session files are kept under; absent in entries from before this was kept. */
  workspaceId?: string;
  closedAt: string;
}

export interface Workspace {
  /** `ws-<8 hex>`; also the id of its terminal session. */
  id: string;
  /** Ticket key or a user-chosen name. */
  name: string;
  ticket: string | null;
  cwd: string;
  /** First URL to open in a new window for this workspace, e.g. its Jira ticket. */
  url: string | null;
  /** The window it lives in; several workspaces can share one. */
  windowId: number | null;
  /** The Chrome tab group holding its tabs, for a workspace that shares a window; null when it has none. */
  groupId: number | null;
  /** Whether it was last open as a tab group. A Chrome restart frees its window and group, and this is what reopens it as a group in the focused window rather than in a window of its own. */
  grouped: boolean;
  /** Kept at the top of the list. */
  pinned: boolean;
  color: WorkspaceColor | null;
  /** A claude session to resume the first time this workspace's terminal starts. */
  resume: string | null;
  /** `claude --model` value; null uses the helper's `defaultModel`. */
  model: string | null;
  /** Tab URLs last seen in its window or group; used to re-pair after Chrome restarts. */
  lastTabUrls: string[];
  /** GitHub PR URL the workspace was created to work on. */
  pr: string | null;
  /** First message for claude; cleared once a session has started with it. */
  prompt: string | null;
  createdAt: string;
}

export type WorkspaceStatus = 'needs_input' | 'working' | 'idle' | null;

/** One of a workspace's claude sessions, for picking an earlier conversation to resume. */
export interface PastSession {
  id: string;
  startedAt: string;
  /** Live status when it is the running one, else null. */
  status: WorkspaceStatus;
  /** The first words typed to it, when its hooks recorded them. */
  firstPrompt: string | null;
}

/** What a workspace at `needs_input` waits on, from claude's Notification: its type (`permission_prompt`, `idle_prompt`, ...) and its words. */
export interface WaitingOn {
  type: string;
  message: string;
}

/** One reusable prompt from the vault note, under the bold heading above it. */
export interface Prompt {
  section: string;
  text: string;
}

/** A git repo that a new workspace can start in. */
export interface Repo {
  name: string;
  path: string;
  /** The folder it was found in, to tell apart repos that share a name. */
  root: string;
}
