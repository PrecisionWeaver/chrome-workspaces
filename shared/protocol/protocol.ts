import type { Template } from '../workspaces/templates';
import type { ActivityItem } from '../sessions/activity';
import type { TimelineEvent } from '../sessions/timeline';
import type { BranchPr, GitBranch, GitCommitFile, GitCompare, GitResultAction, GitState } from './git';
import type { PrDetails, PrThread, ReviewsState } from './pull-requests';
import type { SystemSnapshot, UpdateStatus } from './system';
import type { HistoryEntry, PastSession, Prompt, Repo, WaitingOn, Workspace, WorkspaceColor, WorkspaceStatus } from './workspace';

// The messages the helper and the extension exchange, and the constants both sides agree on; the data they carry is in the files beside this one.
// Shared by the helper and the extension bundle — keep this free of Node imports.

export const PROTOCOL = 'cw.v1';

export const TOKEN_PROTOCOL_PREFIX = 'token.';

export const NATIVE_HOST_NAME = 'com.chrome_workspaces.helper';

export const MAX_PROMPT_LENGTH = 8000;

export const MAX_TAB_URLS = 20;

/** The largest file that can be dropped or pasted into a terminal. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** What `--model` accepts that is safe to put in a shell command: an alias or id, optionally with a `[1m]`-style suffix. */
export const MODEL_PATTERN = /^[A-Za-z0-9][\w.-]{0,63}(\[\w{1,8}\])?$/;

export const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

/** The id of the helper session that runs the system monitor. Workspace ids are `ws-` and eight hex digits, so none can collide. */
export const MONITOR_SESSION = 'monitor';

/** The id of the helper session that runs a plain login shell, for a command line that belongs to no workspace. */
export const SHELL_SESSION = 'shell';

/** A shell of a workspace's own, started in its directory: `shell-<workspace id>`. */
export const WORKSPACE_SHELL_PREFIX = 'shell-';

export const workspaceShellSession = (workspaceId: string): string => `${WORKSPACE_SHELL_PREFIX}${workspaceId}`;

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

export type AdminAction =
  /** Ends the workspace's shell and everything in it; it starts again, resuming the conversation, when opened. */
  | { action: 'restartSession'; id: string }
  /** Signals a process in a workspace's tree, and its descendants. */
  | { action: 'killProcess'; id: string; pid: number; force?: boolean }
  /** Fast-forwards this copy of the app, installs and rebuilds, then restarts the helper. */
  | { action: 'applyUpdate' }
  | { action: 'restartHelper' | 'stopHelper' | 'clearUploads' | 'clearLog' | 'pruneWorktrees' | 'checkGh' };

export type ControlToClient =
  | { type: 'state'; workspaces: Workspace[]; statuses: Record<string, WorkspaceStatus>; waiting: Record<string, WaitingOn>; reviews: ReviewsState }
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
  /** The team's templates from `templatesFile`, read-only in the panel. */
  | { type: 'templates'; templates: Template[]; error: string | null }
  /** Recently removed workspaces, newest first; sent on connect and whenever they change. */
  | { type: 'history'; entries: HistoryEntry[] }
  /** Reply to `checkUpdates`. */
  | { type: 'updates'; status: UpdateStatus | null; error: string | null }
  /** Reply to `timeline`. */
  | { type: 'timeline'; id: string; events: TimelineEvent[]; error: string | null }
  /** Reply to `activity`, and sent again to the same client whenever the workspace's claude does something. */
  | { type: 'activity'; id: string; items: ActivityItem[]; error: string | null }
  /** Reply to `sendText`. */
  | { type: 'sent'; id: string; ok: boolean; message: string }
  /** A `create` that made no workspace, and why; sent to the context that asked. */
  | { type: 'createError'; name: string; message: string }
  /** Reply to `system`, to the client that asked. */
  | { type: 'system'; snapshot: SystemSnapshot | null; error: string | null }
  | { type: 'adminResult'; action: AdminAction['action']; ok: boolean; message: string }
  | { type: 'systemLog'; text: string }
  | { type: 'exportData'; json: string }
  /** The workspace's session was replaced; a panel attached to it should attach again. */
  | { type: 'sessionReset'; id: string }
  /** A workspace's sessions, newest first, in answer to `listSessions`. */
  | { type: 'sessions'; id: string; sessions: PastSession[] }
  /** Reply to `listRepos`, sent only to the client that asked. */
  | { type: 'repos'; repos: Repo[] }
  /** Reply to `git`, to the client that asked; `state` is null when the workspace is not in a git repository. */
  | { type: 'git'; id: string; state: GitState | null; error: string | null }
  | { type: 'gitCommit'; id: string; sha: string; files: GitCommitFile[]; error: string | null }
  | { type: 'gitDiff'; id: string; path: string; sha: string | null; diff: string; truncated: boolean; error: string | null }
  /** Reply to a staging, discard, commit or branch-switch request. */
  /** `url` comes with a pull request just made, for the panel to open. */
  | { type: 'gitResult'; id: string; action: GitResultAction; ok: boolean; message: string; url?: string }
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
      /** Start in a new git worktree of `cwd` on this branch (made if it does not exist), under the repo's `.claude/worktrees/`. */
      worktree?: string;
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
  | { type: 'listSessions'; id: string }
  /** Ends the workspace's terminal and starts it again on this earlier session. */
  | { type: 'resumeSession'; id: string; sessionId: string }
  | { type: 'listPrompts' }
  | { type: 'listTemplates' }
  | { type: 'listRepos' }
  /** A snapshot of the helper, the workspaces' sessions and their processes. */
  | { type: 'system' }
  | { type: 'admin'; request: AdminAction }
  | { type: 'systemLog' }
  /** Fetches and reports whether a newer version of the app is available. */
  | { type: 'checkUpdates' }
  /** What the workspace's claude has recently done, from its transcript. */
  | { type: 'timeline'; id: string }
  /** Follow a workspace's activity: the reply, then an update after every event. Null stops following. */
  | { type: 'activity'; id: string | null }
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
  /** `git push -u origin <branch>`. */
  | { type: 'gitPush'; id: string }
  /** Pushes, then opens a draft pull request for the branch with `gh pr create`. */
  | { type: 'gitCreatePr'; id: string }
  | { type: 'gitCompare'; id: string }
  | { type: 'refreshReviews' }
  | { type: 'prDetails'; url: string }
  /** The review threads on a pull request; read-only. */
  | { type: 'prThreads'; url: string };
