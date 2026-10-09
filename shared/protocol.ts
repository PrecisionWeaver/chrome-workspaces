// Shared by the helper and the extension bundle — keep this free of Node imports.

export const PROTOCOL = 'cw.v1';
export const TOKEN_PROTOCOL_PREFIX = 'token.';
export const NATIVE_HOST_NAME = 'com.chrome_workspaces.helper';
export const MAX_PROMPT_LENGTH = 8000;
export const MAX_TAB_URLS = 20;
export const MAX_PR_BODY = 6000;
/** The largest file that can be dropped or pasted into a terminal. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** What `--model` accepts that is safe to put in a shell command: an alias or id, optionally with a `[1m]`-style suffix. */
export const MODEL_PATTERN = /^[A-Za-z0-9][\w.-]{0,63}(\[\w{1,8}\])?$/;
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku'] as const;

export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  /** A file dropped or pasted into the terminal, `data` as base64; answered with `uploaded`. */
  | { type: 'file'; name: string; data: string };

export type ServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number }
  /** Where a `file` was saved, or why it was not. */
  | { type: 'uploaded'; name: string; path: string | null; error: string | null };

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
  /** The window it lives in; several workspaces can share one. */
  windowId: number | null;
  /** The Chrome tab group holding its tabs, for a workspace that shares a window; null when it has none. */
  groupId: number | null;
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

/** One reusable prompt from the vault note, under the bold heading above it. */
export interface Prompt {
  section: string;
  text: string;
}

/** One changed path in a working tree, as `git status` reports it. */
export interface GitFile {
  path: string;
  /** Status letter in the index (staged), or `?` for untracked; a space when unchanged. */
  index: string;
  /** Status letter in the working tree; a space when unchanged. */
  worktree: string;
  /** Where a renamed or copied file came from. */
  from?: string;
}

export interface GitCommit {
  sha: string;
  short: string;
  author: string;
  /** ISO 8601. */
  date: string;
  /** Branches and tags pointing at it, e.g. `HEAD -> main`, `origin/main`, `tag: v1`. */
  refs: string[];
  parents: string[];
  subject: string;
}

export interface GitState {
  /** The working tree's top directory. */
  root: string;
  /** The name of the linked worktree this is, or null for the main working tree. */
  worktree: string | null;
  /** Null on a detached HEAD. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  commits: GitCommit[];
}

export interface GitCommitFile {
  /** `A`, `M`, `D`, `R`, `C` or `T`. */
  status: string;
  path: string;
  from?: string;
}

/** A git repo that a new workspace can start in. */
export interface Repo {
  name: string;
  path: string;
  /** The folder it was found in, to tell apart repos that share a name. */
  root: string;
}

/**
 * Where a PR stands: `ready` can merge now (approved, checks passing, no conflicts), `review` is open
 * and waiting for a review, `draft` is not up for review yet, and `blocked` cannot merge for a stated reason.
 */
export type MergeState = 'ready' | 'review' | 'draft' | 'blocked' | 'unknown';

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
  merge: MergeState;
  /** Why a `blocked` PR cannot merge, in a word or two; null otherwise. */
  mergeReason: string | null;
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
  /** The description as written, in GitHub markdown, cut at `MAX_PR_BODY` characters. */
  body: string;
  labels: string[];
  /** Conversation comments, not counting review comments on code. */
  comments: number;
  /** The files with the most changes first, at most `PR_FILES_SHOWN`. */
  files: PrFile[];
  /** Newest first, at most `PR_COMMITS_SHOWN`. */
  commits: PrCommit[];
  commitCount: number;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrCommit {
  sha: string;
  headline: string;
  author: string;
  date: string;
}

export const PR_FILES_SHOWN = 10;
export const PR_COMMITS_SHOWN = 6;

export type ControlToClient =
  | { type: 'state'; workspaces: Workspace[]; statuses: Record<string, WorkspaceStatus>; reviews: ReviewsState }
  | { type: 'open'; id: string }
  /** Make the workspace's tab group in the window it was paired with. */
  | { type: 'group'; id: string }
  | { type: 'focus'; id: string }
  /** The workspace's claude used Claude in Chrome at `at` (epoch ms). */
  | { type: 'browser'; id: string; at: number }
  /** Reply to `listPrompts`, sent only to the client that asked. */
  | { type: 'prompts'; prompts: Prompt[]; error: string | null }
  /** Reply to `listRepos`, sent only to the client that asked. */
  | { type: 'repos'; repos: Repo[] }
  /** Reply to `git`, to the client that asked; `state` is null when the workspace is not in a git repository. */
  | { type: 'git'; id: string; state: GitState | null; error: string | null }
  | { type: 'gitCommit'; id: string; sha: string; files: GitCommitFile[]; error: string | null }
  | { type: 'gitDiff'; id: string; path: string; sha: string | null; diff: string; truncated: boolean; error: string | null }
  /** Reply to `prDetails`, sent only to the client that asked. */
  | { type: 'prDetails'; url: string; details: PrDetails | null; error: string | null };

export type ControlToHelper =
  | { type: 'pair'; id: string; windowId: number; groupId?: number }
  | { type: 'unpair'; windowId: number }
  /** The tab group closed; its workspace keeps its window. */
  | { type: 'unpairGroup'; groupId: number }
  | { type: 'tabs'; windowId: number; urls: string[]; groupId?: number }
  /** With `pr`, focuses the PR's existing workspace instead of creating another. */
  | { type: 'create'; name: string; windowId: number | null; pr?: string; prompt?: string; cwd?: string; model?: string; group?: boolean; urls?: string[] }
  | { type: 'remove'; id: string }
  | { type: 'rename'; id: string; name: string }
  /** `index` is the workspace's position in the list once moved. */
  | { type: 'move'; id: string; index: number }
  | { type: 'listPrompts' }
  | { type: 'listRepos' }
  /** Status and recent history of the workspace's repository. */
  | { type: 'git'; id: string }
  | { type: 'gitCommit'; id: string; sha: string }
  /** A file's diff against HEAD, or its change in commit `sha`. */
  | { type: 'gitDiff'; id: string; path: string; sha?: string }
  | { type: 'refreshReviews' }
  | { type: 'prDetails'; url: string };
