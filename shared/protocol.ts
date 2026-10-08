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

/** An open PR that requests the user's review. */
export interface ReviewRequest {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
  ticket: string | null;
}

export interface ReviewsState {
  items: ReviewRequest[];
  /** Why the last fetch failed; `items` then still holds the last good list. */
  error: string | null;
  fetchedAt: string | null;
}

export interface PrReview {
  login: string;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, or PENDING. */
  state: string;
  at: string | null;
}

export interface PrDetails {
  url: string;
  title: string;
  author: string;
  head: string;
  base: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null when no review is required. */
  reviewDecision: string | null;
  /** MERGEABLE, CONFLICTING, or UNKNOWN. */
  mergeable: string;
  createdAt: string;
  updatedAt: string;
  /** Each reviewer's latest review. */
  reviews: PrReview[];
  /** Users and teams whose review is still requested. */
  requested: string[];
  checks: { passed: number; failed: number; pending: number; failing: string[] };
}

export type ControlToClient =
  | { type: 'state'; workspaces: Workspace[]; statuses: Record<string, WorkspaceStatus>; reviews: ReviewsState }
  | { type: 'open'; id: string }
  | { type: 'focus'; id: string }
  /** The workspace's claude used Claude in Chrome at `at` (epoch ms). */
  | { type: 'browser'; id: string; at: number }
  /** Reply to `listPrompts`, sent only to the client that asked. */
  | { type: 'prompts'; prompts: Prompt[]; error: string | null }
  /** Reply to `prDetails`, sent only to the client that asked. */
  | { type: 'prDetails'; url: string; details: PrDetails | null; error: string | null };

export type ControlToHelper =
  | { type: 'pair'; id: string; windowId: number }
  | { type: 'unpair'; windowId: number }
  | { type: 'tabs'; windowId: number; urls: string[] }
  /** With `pr`, focuses the PR's existing workspace instead of creating another. */
  | { type: 'create'; name: string; windowId: number | null; pr?: string; prompt?: string }
  | { type: 'remove'; id: string }
  | { type: 'rename'; id: string; name: string }
  /** `index` is the workspace's position in the list once moved. */
  | { type: 'move'; id: string; index: number }
  | { type: 'listPrompts' }
  | { type: 'refreshReviews' }
  | { type: 'prDetails'; url: string };
