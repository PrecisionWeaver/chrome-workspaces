import type { GuardrailWarning } from '../usage/guardrails';
import type { WorkspaceStatus } from './workspace';

// What Settings shows: sessions, processes, usage, plan limits and updates. Shared by the helper and the extension bundle — keep this free of Node imports.

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
    /** Percent of one core, as `ps` reports it. Absent from a helper that predates it. */
    cpu?: number;
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
    /** The team's prompt notes and templates, when configured. */
    promptsFiles: string[];
    templatesFile: string | null;
    defaultModel: string | null;
    claudeCommand: string;
    claudeArgs: string[];
    repoRoots: string[];
    repoDirs: Record<string, string>;
    watchRepos: string[];
    limits: { memoryWarnMb: number; idleServerHours: number };
    pricing: Record<string, { input: number; output: number }>;
    jiraBaseUrl: string | null;
  };
  /** Tokens and estimated cost across every workspace, by day (local time), oldest first; see `shared/usage/pricing.ts` and `shared/usage/usage.ts`. */
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
