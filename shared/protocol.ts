// Shared by the helper and the extension bundle — keep this free of Node imports.

export const PROTOCOL = 'cw.v1';
export const TOKEN_PROTOCOL_PREFIX = 'token.';
export const NATIVE_HOST_NAME = 'com.chrome_workspaces.helper';
export const MAX_PROMPT_LENGTH = 8000;

export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type ServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number };

export type NativeHostReply =
  | { ok: true; token: string; port: number }
  | { ok: false; error: string };

export interface Workspace {
  /** `ws-<8 hex>`; also the id of its terminal session. */
  id: string;
  /** Ticket key or a user-chosen name. */
  name: string;
  ticket: string | null;
  cwd: string;
  /** First URL to open in a new window for this workspace, e.g. its Jira ticket. */
  url: string | null;
  windowId: number | null;
  /** Tab URLs last seen in its window; used to re-pair after Chrome restarts. */
  lastTabUrls: string[];
  /** GitHub PR URL the workspace was created to work on. */
  pr: string | null;
  /** First message for claude; cleared once a session has started with it. */
  prompt: string | null;
  createdAt: string;
}

export type WorkspaceStatus = 'needs_input' | 'working' | 'idle' | null;

/** One reusable prompt from the vault note, under the bold heading above it. */
export interface Prompt {
  section: string;
  text: string;
}

export type ControlToClient =
  | { type: 'state'; workspaces: Workspace[]; statuses: Record<string, WorkspaceStatus> }
  | { type: 'open'; id: string }
  | { type: 'focus'; id: string }
  /** The workspace's claude used Claude in Chrome at `at` (epoch ms). */
  | { type: 'browser'; id: string; at: number };

export type ControlToHelper =
  | { type: 'pair'; id: string; windowId: number }
  | { type: 'unpair'; windowId: number }
  | { type: 'tabs'; windowId: number; urls: string[] }
  | { type: 'create'; name: string; windowId: number | null }
  | { type: 'remove'; id: string }
  | { type: 'rename'; id: string; name: string };
