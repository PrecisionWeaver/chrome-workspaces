// Shared by the helper and the extension bundle — keep this free of Node imports.

import type { GuardrailWarning } from './guardrails';
import type { TimelineEvent } from './timeline';

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
/** Colors a workspace can be marked with; the names Chrome uses for tab groups. */
export const WORKSPACE_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange'] as const;
export type WorkspaceColor = (typeof WORKSPACE_COLORS)[number];

/** The id of the helper session that runs the system monitor. Workspace ids are `ws-` and eight hex digits, so none can collide. */
export const MONITOR_SESSION = 'monitor';

/** The id of the helper session that runs a plain login shell, for a command line that belongs to no workspace. */
export const SHELL_SESSION = 'shell';

export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  /** A file dropped or pasted into the terminal, `data` as base64; answered with `uploaded`. */
  | { type: 'file'; name: string; data: string };

export type ServerMessage =
  /** `replay` is saved scrollback: its queries were already answered, so the panel must not answer them again. */
  | { type: 'output'; data: string; replay?: boolean }
  | { type: 'exit'; code: number }
  /** Where a `file` was saved, or why it was not. */
  | { type: 'uploaded'; name: string; path: string | null; error: string | null };

export type NativeHostRequest = { type: 'hello' } | { type: 'start' };

export type NativeHostReply = { ok: true; token: string; port: number } | { ok: false; error: string };

/** The reply to `start`: the helper was asked to start, which does not mean it is listening yet. */
export type NativeStartReply = { ok: true } | { ok: false; error: string };

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

/** Tokens a claude session has used. */
export interface TokenTotals {
  /** Input not served from the cache. */
  input: number;
  output: number;
  /** Input written to the prompt cache. */
  cacheWrite: number;
  /** Input read back from the prompt cache. */
  cacheRead: number;
}

/** One day's use across every workspace. */
export interface UsageDay {
  /** The date in the machine's time zone, `2026-10-07`. */
  day: string;
  /** New work: input, output and cache writes. */
  tokens: number;
  costUsd: number;
  output: number;
  /** Input served from the prompt cache; it repeats earlier input, so it is not in `tokens`. */
  cacheRead: number;
  /** The real models that did the work, with what each cost; empty on a quiet day. */
  models: { model: string; tokens: number; costUsd: number }[];
}

/** One workspace's use on one day, for the split by workspace. */
export interface UsageWorkspace {
  id: string;
  name: string;
  /** Only the days it used anything, oldest first, over the same history as `UsageSnapshot.daily`. */
  daily: { day: string; tokens: number; costUsd: number }[];
}

/** One hour of today's use across every workspace. */
export interface UsageHour {
  /** The hour in the machine's time zone, 0 to 23. */
  hour: number;
  /** New work, counted as in `UsageDay`. */
  tokens: number;
  costUsd: number;
}

/** One process in a workspace's shell tree. */
export interface SystemProcess {
  pid: number;
  ppid: number;
  command: string;
  cpu: number;
  rssKb: number;
  /** Time since it started, as `ps` prints it, e.g. `01:23:45`. */
  elapsed: string;
  /** TCP ports it is listening on. */
  ports: number[];
}

/** What a session's shell tree was using at one moment. */
export interface ResourceSample {
  /** Epoch milliseconds. */
  t: number;
  rssKb: number;
  /** Summed across its processes, so it can pass 100 on several cores. */
  cpu: number;
}

export interface SystemSession {
  id: string;
  name: string;
  /** The shell's pid; null when no session is running for the workspace. */
  pid: number | null;
  status: WorkspaceStatus;
  cwd: string;
  cwdMissing: boolean;
  claudeSessionId: string | null;
  /** What its claude session has used, counted from the transcript; null when there is none. `counting` while the first read is still running. */
  tokens: (TokenTotals & { counting: boolean; costUsd: number }) | null;
  /** The shell and everything beneath it, shell first. */
  processes: SystemProcess[];
  /** Its recent memory and CPU, oldest first, one sample a minute; empty until it has been sampled. */
  history: ResourceSample[];
}

/** One of the plan's rate limits, as `/usage` shows it. */
export interface PlanLimit {
  id: string;
  label: string;
  /** Share used, 0 to 100 (a spend limit can pass 100). */
  percent: number;
  /** When it resets; always in the future, since a window that has passed is dropped. */
  resetsAt: string;
  /** Estimated spend against a dollar limit, when claude reports it (a gateway's spend limit, on newer versions). */
  spend?: { usedUsd: number; limitUsd: number; period: 'daily' | 'weekly' | 'monthly' };
}

/** The plan's limits as claude last reported them to a workspace's status line; empty when none has yet, or the plan has none. */
export interface PlanUsage {
  limits: PlanLimit[];
  /** When claude last reported them, so the card can say how old they are. */
  updatedAt: string | null;
}

export interface SystemSnapshot {
  takenAt: string;
  helper: {
    pid: number;
    uptimeSec: number;
    rssKb: number;
    port: number;
    node: string;
    commit: string | null;
    /** Whether launchd runs and can restart it; false when started by hand. */
    managed: boolean;
    clients: number;
    logPath: string;
    configPath: string;
    extensionId: string;
  };
  sessions: SystemSession[];
  storage: { uploadsBytes: number; logBytes: number; dataBytes: number };
  config: {
    defaultCwd: string;
    promptsFile: string;
    defaultModel: string | null;
    claudeCommand: string;
    repoRoots: string[];
    repoDirs: Record<string, string>;
    watchRepos: string[];
    limits: { memoryWarnMb: number; idleServerHours: number };
    pricing: Record<string, { input: number; output: number }>;
    jiraBaseUrl: string | null;
  };
  /** Tokens and estimated cost across every workspace, by day (local time), oldest first; see `shared/pricing.ts` and `shared/usage.ts`. */
  usage: {
    daily: UsageDay[];
    /** Today's use by hour, in local time: always 24 entries, 0 to 23, with the hours not yet reached at zero. */
    hourly: UsageHour[];
    /** Each workspace's use by day, so a range can be split by workspace; the busiest first is up to the card. */
    workspaces: UsageWorkspace[];
    /** Estimated cost across each workspace's current claude session, not only the days in `daily`. */
    costUsd: number;
    counting: boolean;
    /** Models used that have no rate, so are missing from the cost. */ unpriced: string[];
  };
  plan: PlanUsage;
  /** Workspaces using a lot of memory, and servers left running; see `findWarnings`. */
  warnings: GuardrailWarning[];
  reviews: { fetchedAt: string | null; count: number; error: string | null };
  /** Facts about the install that only the helper can see, for the setup checklist. */
  setup: {
    promptsFileExists: boolean;
    repoRoots: { path: string; exists: boolean }[];
    /** The status hooks are set up; status, attention, activity and cost all come from them. */
    statusHooks: boolean;
    /** Config entries the helper ignored, and why. */
    configProblems: string[];
  };
}

/** Whether this copy of the app is behind the newest release, and whether it is safe to fast-forward. */
export interface UpdateStatus {
  /** Short id of the commit running now. */
  current: string;
  branch: string;
  upstream: string | null;
  /** The newest `vX.Y.Z` tag, which updates go to; null when there are none and the upstream is followed. */
  release: string | null;
  behind: number;
  ahead: number;
  /** Tracked files have uncommitted changes. */
  dirty: boolean;
  /** What the update brings, newest first. */
  commits: { short: string; subject: string }[];
  canUpdate: boolean;
  /** Why it cannot be updated, or that it is already current. */
  reason: string | null;
}

export type AdminAction =
  /** Ends the workspace's shell and everything in it; it starts again, resuming the conversation, when opened. */
  | { action: 'restartSession'; id: string }
  /** Signals a process in a workspace's tree, and its descendants. */
  | { action: 'killProcess'; id: string; pid: number; force?: boolean }
  /** Fast-forwards this copy of the app, installs and rebuilds, then restarts the helper. */
  | { action: 'applyUpdate' }
  | { action: 'restartHelper' | 'stopHelper' | 'clearUploads' | 'clearLog' | 'pruneWorktrees' | 'checkGh' };

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

/** The pull request for a workspace's current branch. */
export interface BranchPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: string | null;
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
}

export interface GitCompare {
  /** The branch compared against, e.g. `origin/main`. */
  base: string;
  /** The commit the current branch forked from. */
  mergeBase: string;
  /** Commits on the current branch that the base does not have. */
  ahead: number;
  files: GitCommitFile[];
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

/** The head commit's checks as a whole; a PR with no checks has none. */
export type CiState = 'passing' | 'failing' | 'pending';

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
  /** The PR's head branch; empty until the merge lookup has answered. */
  branch: string;
  merge: MergeState;
  /** Why a `blocked` PR cannot merge, in a word or two; null otherwise. */
  mergeReason: string | null;
  /** Your last review asked for changes or commented, and the author has pushed since. */
  needsReReview: boolean;
  /** Your latest review on the PR is an approval. */
  approved: boolean;
  /** Null when the PR has no checks, or the lookup that carries them failed. */
  ci: CiState | null;
}

export interface ReviewsState {
  items: ReviewRequest[];
  /** Why the last fetch failed; `items` then still holds the last good list. */
  error: string | null;
  fetchedAt: string | null;
  /** A fetch is running; the panel disables its refresh button until it finishes. */
  refreshing: boolean;
}

export interface PrReview {
  login: string;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, or PENDING. */
  state: string;
  at: string | null;
}

/** One comment in a pull request's review thread. */
export interface PrThreadComment {
  author: string;
  body: string;
  at: string;
  /** Opens the comment on GitHub. */
  url: string;
}

/** A thread of review comments on a line of the diff. */
export interface PrThread {
  path: string;
  /** The line it is on now, or where it was before the code moved; null for a comment on the whole file. */
  line: number | null;
  resolved: boolean;
  /** The code it was written on has since changed. */
  outdated: boolean;
  comments: PrThreadComment[];
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
  /** Closes the tab group, or the whole window when `groupId` is null, of a workspace that was just archived. */
  | { type: 'closeTabs'; windowId: number; groupId: number | null }
  /** The workspace's claude used Claude in Chrome at `at` (epoch ms). */
  | { type: 'browser'; id: string; at: number }
  /** Reply to `listPrompts`, sent only to the client that asked. */
  | { type: 'prompts'; prompts: Prompt[]; error: string | null }
  /** Recently removed workspaces, newest first; sent on connect and whenever they change. */
  | { type: 'history'; entries: HistoryEntry[] }
  /** Reply to `checkUpdates`. */
  | { type: 'updates'; status: UpdateStatus | null; error: string | null }
  /** Reply to `timeline`. */
  | { type: 'timeline'; id: string; events: TimelineEvent[]; error: string | null }
  /** Reply to `sendText`. */
  | { type: 'sent'; id: string; ok: boolean; message: string }
  /** Reply to `system`, to the client that asked. */
  | { type: 'system'; snapshot: SystemSnapshot | null; error: string | null }
  | { type: 'adminResult'; action: string; ok: boolean; message: string }
  | { type: 'systemLog'; text: string }
  | { type: 'exportData'; json: string }
  /** The workspace's session was replaced; a panel attached to it should attach again. */
  | { type: 'sessionReset'; id: string }
  /** Reply to `listRepos`, sent only to the client that asked. */
  | { type: 'repos'; repos: Repo[] }
  /** Reply to `git`, to the client that asked; `state` is null when the workspace is not in a git repository. */
  | { type: 'git'; id: string; state: GitState | null; error: string | null }
  | { type: 'gitCommit'; id: string; sha: string; files: GitCommitFile[]; error: string | null }
  | { type: 'gitDiff'; id: string; path: string; sha: string | null; diff: string; truncated: boolean; error: string | null }
  /** Reply to a staging, discard, commit or branch-switch request. */
  | { type: 'gitResult'; id: string; action: string; ok: boolean; message: string }
  | { type: 'gitBranches'; id: string; branches: GitBranch[]; error: string | null }
  /** `pr` is null when the branch has no pull request. */
  | { type: 'gitChecks'; id: string; pr: BranchPr | null; checks: PrDetails['checks'] | null; error: string | null }
  | { type: 'gitCompare'; id: string; compare: GitCompare | null; error: string | null }
  /** Reply to `prThreads`, sent only to the client that asked; `total` can exceed `threads.length`. */
  | { type: 'prThreads'; url: string; threads: PrThread[]; total: number; error: string | null }
  /** Reply to `prDetails`, sent only to the client that asked. */
  | { type: 'prDetails'; url: string; details: PrDetails | null; error: string | null };

export type ControlToHelper =
  | { type: 'pair'; id: string; windowId: number; groupId?: number }
  | { type: 'unpair'; windowId: number }
  /** The tab group closed; its workspace keeps its window. */
  | { type: 'unpairGroup'; groupId: number }
  | { type: 'tabs'; windowId: number; urls: string[]; groupId?: number }
  /** With `pr`, focuses the PR's existing workspace instead of creating another. */
  | {
      type: 'create';
      name: string;
      windowId: number | null;
      pr?: string;
      prompt?: string;
      cwd?: string;
      model?: string;
      color?: WorkspaceColor;
      group?: boolean;
      urls?: string[];
    }
  /** Archives a workspace; with `closeTabs` its tab group (or window, when it has no group) closes too. */
  | { type: 'remove'; id: string; closeTabs?: boolean }
  | { type: 'rename'; id: string; name: string }
  /** Pins or colors a workspace; a missing field is left as it is. */
  | { type: 'mark'; id: string; pinned?: boolean; color?: WorkspaceColor | null }
  /** `index` is the workspace's position in the list once moved. */
  | { type: 'move'; id: string; index: number }
  /** Sets the whole list order at once; ignored unless `ids` is exactly the current workspaces. */
  | { type: 'order'; ids: string[] }
  /** Brings a removed workspace back, in `windowId` or a new window, resuming its conversation. */
  | { type: 'restore'; historyId: string; windowId: number | null }
  /** Forgets a removed workspace. */
  | { type: 'forget'; historyId: string }
  /** Forgets every archived workspace. */
  | { type: 'forgetAll' }
  /** Pastes text into the workspace's terminal without submitting it; answered with `sent`. */
  | { type: 'sendText'; id: string; text: string }
  | { type: 'listPrompts' }
  | { type: 'listRepos' }
  /** A snapshot of the helper, the workspaces' sessions and their processes. */
  | { type: 'system' }
  | { type: 'admin'; request: AdminAction }
  | { type: 'systemLog' }
  /** Fetches and reports whether a newer version of the app is available. */
  | { type: 'checkUpdates' }
  /** What the workspace's claude has recently done, from its transcript. */
  | { type: 'timeline'; id: string }
  | { type: 'exportData' }
  /** Status and recent history of the workspace's repository. */
  | { type: 'git'; id: string }
  | { type: 'gitCommit'; id: string; sha: string }
  /** A file's diff against HEAD, or its change in commit `sha`. */
  | {
      type: 'gitDiff';
      id: string;
      path: string;
      sha?: string;
      /** The file's change since the branch forked from its base. */
      base?: boolean;
    }
  /** Stages or unstages `paths`; with no paths, everything. */
  | { type: 'gitStage'; id: string; paths: string[]; stage: boolean }
  /** Throws away the working-tree changes of `paths`, deleting untracked ones. */
  | { type: 'gitDiscard'; id: string; paths: string[] }
  /** Commits what is staged. */
  | { type: 'gitSave'; id: string; message: string }
  | { type: 'gitBranches'; id: string }
  | { type: 'gitChecks'; id: string }
  | { type: 'gitSwitch'; id: string; branch: string }
  | { type: 'gitCompare'; id: string }
  | { type: 'refreshReviews' }
  | { type: 'prDetails'; url: string }
  /** The review threads on a pull request; read-only. */
  | { type: 'prThreads'; url: string };
