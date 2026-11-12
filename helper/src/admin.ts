import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tailLines } from './tail';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findWarnings } from '../../shared/guardrails';
import { costOf, isRealModel, rateFor } from '../../shared/pricing';
import type {
  AdminAction,
  PlanUsage,
  ReviewsState,
  SystemSnapshot,
  UpdateStatus,
  UsageDay,
  UsageHour,
  UsageWorkspace,
  WorkspaceStatus,
} from '../../shared/protocol';
import { localDay, localDayBack, USAGE_HISTORY_DAYS } from '../../shared/usage';
import { AGENT_LABEL, type HelperConfig } from './config';
import type { SessionManager } from './session';
import { ResourceHistory } from './resource-history';
import { readTimeline } from './timeline';
import { applyUpdate, checkUpdates } from './updates';
import { TranscriptTokens, type UsageBucket } from './tokens';
import { UsageLedger } from './usage-ledger';
import { pathBytes, readListening, readProcesses, subtree, toSystemProcess, type Proc } from './system';
import type { WorkspaceStore } from './workspace-store';
import { errorMessage } from '../../shared/errors';

const execFileAsync = promisify(execFile);

const LOG_TAIL_BYTES = 64 * 1024;

const USAGE_LEDGER_FILE = 'usage.json';

export interface AdminOptions {
  sessions: SessionManager;
  store: WorkspaceStore;
  config: HelperConfig;
  /** `hooksFile` is the claude settings file that adds the status hooks; null when they cannot run. */
  paths: { dataDir: string; uploadDir: string; logFile: string; configFile: string; workspacesFile: string; hooksFile: string | null };
  port: number;
  /** Where this copy of the app is installed, for updating it; null when it is not a git checkout. */
  repoDir: string | null;
  /** The helper's own commit, when it can be read. */
  commit: string | null;
  status: (id: string) => { status: WorkspaceStatus; claudeSessionId: string | null };
  /** The transcript of the workspace's current claude session, for counting its tokens. */
  transcript: (id: string) => string | null;
  /** Archived workspaces whose session files are still kept, so a transcript the ledger has not yet counted is counted into it. */
  archived?: () => { id: string; name: string; transcript: string }[];
  /** Runs a command line in a login shell, resolving with its output and whether it exited cleanly. */
  runShell: (command: string) => Promise<{ output: string; ok: boolean }>;
  /** Starts a command that outlives the helper. */
  spawnDetached: (command: string) => void;
  /** Whether launchd runs this process. */
  isManaged: () => Promise<boolean>;
  processes?: () => Promise<Proc[]>;
  /** The plan's limits from the status line wrapper; none when absent. */
  planUsage?: () => PlanUsage;
}

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Workspaces whose session was replaced, so attached panels can attach again. */
  reset?: string[];
}

export interface AdminService {
  snapshot(extra: { reviews: ReviewsState; clients: number }): Promise<SystemSnapshot>;
  run(request: AdminAction): Promise<ActionResult>;
  log(): string;
  checkUpdates(): Promise<UpdateStatus>;
  /** Recent events from a workspace's claude transcript; null when it has none. */
  timeline(id: string): ReturnType<typeof readTimeline> | null;
  exportData(): string;
  /** Records each running session's memory and CPU for its trend; called on a timer, since a snapshot is only taken while Settings is open. */
  sample(now?: number): Promise<void>;
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function defaultRunShell(shell: string) {
  return async (command: string): Promise<{ output: string; ok: boolean }> => {
    try {
      const { stdout, stderr } = await execFileAsync(shell, ['-l', '-c', command], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      return { output: `${stdout}${stderr}`.trim(), ok: true };
    } catch (error) {
      const { stdout, stderr } = error as { stdout?: string; stderr?: string };
      return { output: `${stdout ?? ''}${stderr ?? ''}`.trim() || errorMessage(error), ok: false };
    }
  };
}

export function defaultSpawnDetached(command: string): void {
  spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' }).unref();
}

export async function defaultIsManaged(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${AGENT_LABEL}`], { timeout: 5000 });
    return stdout.includes(`pid = ${process.pid}`);
  } catch {
    return false;
  }
}

/** One day's use as it is added up, before it becomes a `UsageDay`. */
type DayTotals = Omit<UsageDay, 'day' | 'models'> & { models: Map<string, { tokens: number; costUsd: number }> };

export const emptyDay = (): DayTotals => ({ tokens: 0, costUsd: 0, output: 0, cacheRead: 0, models: new Map() });

/** The last `USAGE_HISTORY_DAYS`, oldest first, with a day that had no usage shown as zero so the trend has no gaps. */
export function usageTrend(
  dayTotals: ReadonlyMap<string, DayTotals>,
  counting: boolean,
  unpriced: string[] = [],
  now = new Date(),
): Omit<SystemSnapshot['usage'], 'hourly' | 'workspaces'> {
  const daily: UsageDay[] = [];
  for (let back = USAGE_HISTORY_DAYS - 1; back >= 0; back--) {
    const day = localDayBack(now, back);
    const { models, ...totals } = dayTotals.get(day) ?? emptyDay();
    daily.push({ day, ...totals, models: [...models].map(([model, used]) => ({ model, ...used })) });
  }
  let costUsd = 0;
  for (const total of dayTotals.values()) costUsd += total.costUsd;
  return { daily, costUsd, counting, unpriced };
}

/** Today's use by hour, from the totals of each local hour that had any; every hour is listed so the chart has no gaps. */
export function usageByHour(hourTotals: ReadonlyMap<number, { tokens: number; costUsd: number }>): UsageHour[] {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, ...(hourTotals.get(hour) ?? { tokens: 0, costUsd: 0 }) }));
}

/** One row per workspace: a workspace with several transcripts (before and after a `/clear`) has its days added together. */
export function mergeWorkspaces(rows: readonly UsageWorkspace[]): UsageWorkspace[] {
  const merged = new Map<string, { name: string; days: Map<string, { tokens: number; costUsd: number }> }>();
  for (const { id, name, daily } of rows) {
    const into = merged.get(id) ?? { name, days: new Map() };
    for (const { day, tokens, costUsd } of daily) {
      const seen = into.days.get(day) ?? { tokens: 0, costUsd: 0 };
      seen.tokens += tokens;
      seen.costUsd += costUsd;
      into.days.set(day, seen);
    }
    merged.set(id, into);
  }
  return [...merged].map(([id, { name, days }]) => ({
    id,
    name,
    daily: [...days].map(([day, used]) => ({ day, ...used })).sort((a, b) => a.day.localeCompare(b.day)),
  }));
}

export function createAdmin(options: AdminOptions): AdminService {
  const { sessions, store, config, paths } = options;
  const readProcs = options.processes ?? readProcesses;
  // Live transcripts only: anything else is counted once into the ledger and then read from there.
  const tokens = new TranscriptTokens();
  const ledger = new UsageLedger(join(paths.dataDir, USAGE_LEDGER_FILE));
  const history = new ResourceHistory();

  /** Each workspace's current transcript, by path. */
  const liveTranscripts = () => {
    const live = new Map<string, { id: string; name: string }>();
    for (const ws of store.list()) {
      const transcript = options.transcript(ws.id);
      if (transcript) live.set(transcript, { id: ws.id, name: ws.name });
    }
    return live;
  };

  const save = (transcript: string, owner: { id: string; name: string }, counted: NonNullable<ReturnType<TranscriptTokens['peek']>>) => {
    const { createdMs, mtimeMs, lastAt, buckets } = counted;
    ledger.record({ transcript, workspaceId: owner.id, name: owner.name, createdMs, mtimeMs, lastAt, buckets });
  };
  /** Puts a live transcript's figures in the ledger once it has been read to the end, so they outlast its session. */
  const recordLive = (transcript: string, owner: { id: string; name: string }) => {
    const counted = tokens.peek(transcript);
    if (!counted || counted.scanning) return;
    save(transcript, owner, counted);
  };
  /** When the conversations a transcript may have copied from ended, from the ledger; null when it cannot be read. */
  const earlierEnded = (transcript: string, workspaceId: string) => {
    try {
      return ledger.earlierEnded(workspaceId, statSync(transcript).birthtimeMs);
    } catch {
      return null;
    }
  };
  const refreshLive = (transcript: string, owner: { id: string }) => tokens.refresh(transcript, earlierEnded(transcript, owner.id));

  let settling: Promise<void> | null = null;
  /**
   * Counts into the ledger every transcript that is no longer live and has been written to since it was last counted:
   * an archived workspace's, or one left behind by `/clear`, a restart or a fork. Each is read once by a counter of its
   * own, so none stays in memory. Then old days are dropped and the file is written.
   */
  const settle = (): Promise<void> => {
    settling ??= (async () => {
      const live = liveTranscripts();
      const pending = new Map<string, { id: string; name: string }>();
      for (const entry of ledger.list()) {
        if (live.has(entry.transcript)) continue;
        try {
          if (statSync(entry.transcript).mtimeMs > entry.mtimeMs) pending.set(entry.transcript, { id: entry.workspaceId, name: entry.name });
        } catch {
          // Claude deleted it; the figures it left stay.
        }
      }
      for (const a of options.archived?.() ?? []) {
        if (!live.has(a.transcript) && !ledger.get(a.transcript)) pending.set(a.transcript, { id: a.id, name: a.name });
      }
      // Oldest first, so a fork is counted after the conversation it copied.
      const created = (path: string) => {
        try {
          return statSync(path).birthtimeMs;
        } catch {
          return 0;
        }
      };
      for (const [transcript, owner] of [...pending].sort(([a], [b]) => created(a) - created(b))) {
        const once = new TranscriptTokens();
        await once.refresh(transcript, earlierEnded(transcript, owner.id));
        const counted = once.peek(transcript);
        if (counted) save(transcript, owner, counted);
      }
      for (const [transcript, owner] of live) recordLive(transcript, owner);
      const now = new Date();
      ledger.prune(localDayBack(now, USAGE_HISTORY_DAYS - 1), localDay(now));
      ledger.save();
    })().finally(() => {
      settling = null;
    });
    return settling;
  };

  const launchctl = (verb: 'kickstart -k' | 'bootout') => `sleep 1; launchctl ${verb} gui/${process.getuid?.() ?? 0}/${AGENT_LABEL}`;

  async function killProcess(id: string, pid: number, force: boolean): Promise<ActionResult> {
    const root = sessions.get(id)?.pid;
    if (root == null) return { ok: false, message: 'That workspace has no running session.' };
    const tree = subtree(await readProcs(), root);
    // Only processes inside the workspace's own shell tree can be signalled, never the shell itself or the helper.
    if (pid === root || pid === process.pid || !tree.some((p) => p.pid === pid)) {
      return { ok: false, message: 'That process is not running inside this workspace.' };
    }
    const doomed = subtree(tree, pid).reverse();
    for (const proc of doomed) {
      try {
        process.kill(proc.pid, force ? 'SIGKILL' : 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
    return { ok: true, message: `${force ? 'Killed' : 'Asked to stop'} ${doomed.length} process${doomed.length === 1 ? '' : 'es'}.` };
  }

  async function pruneWorktrees(): Promise<ActionResult> {
    const roots = new Map<string, string>();
    for (const ws of store.list()) {
      if (!existsSync(ws.cwd)) continue;
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ws.cwd, timeout: 10_000 });
        roots.set(stdout.trim(), ws.cwd);
      } catch {
        // Not a repository.
      }
    }
    let pruned = 0;
    for (const cwd of roots.values()) {
      try {
        const { stdout, stderr } = await execFileAsync('git', ['worktree', 'prune', '-v'], { cwd, timeout: 30_000 });
        pruned += `${stdout}${stderr}`.split('\n').filter((line) => line.startsWith('Removing')).length;
      } catch {
        // Leave a repository that will not prune.
      }
    }
    return {
      ok: true,
      message: `Checked ${roots.size} repositor${roots.size === 1 ? 'y' : 'ies'}; removed ${pruned} stale worktree record${pruned === 1 ? '' : 's'}.`,
    };
  }

  return {
    async snapshot({ reviews, clients }) {
      const [procs, listening, managed] = await Promise.all([readProcs(), readListening(), options.isManaged()]);
      const snapshotSessions = store.list();
      // A live transcript is counted as it grows; every other one comes from the ledger, so none is counted twice.
      const live = liveTranscripts();
      tokens.keepOnly(live.keys());
      void settle().catch(() => {});
      // Every counted transcript's usage by model and day, for the trend across workspaces.
      const dayTotals = new Map<string, DayTotals>();
      const today = localDay(new Date());
      const hourTotals = new Map<number, { tokens: number; costUsd: number }>();
      const workspaceUsage: UsageWorkspace[] = [];
      let counting = false;
      const unpriced = new Set<string>();
      /** Adds usage to the trend and to its workspace's row; returns what it cost. */
      const addUsage = (id: string, name: string, buckets: readonly UsageBucket[]) => {
        let costUsd = 0;
        const ownDays = new Map<string, { tokens: number; costUsd: number }>();
        for (const bucket of buckets) {
          const cost = costOf(bucket.usage, bucket.model, config.pricing);
          if (isRealModel(bucket.model) && !rateFor(bucket.model, config.pricing)) unpriced.add(bucket.model);
          costUsd += cost;
          if (bucket.day) {
            const day = dayTotals.get(bucket.day) ?? emptyDay();
            // New work only, as everywhere else: cache reads repeat earlier input.
            const tokens = bucket.usage.input + bucket.usage.output + bucket.usage.cacheWrite;
            day.tokens += tokens;
            day.costUsd += cost;
            day.output += bucket.usage.output;
            day.cacheRead += bucket.usage.cacheRead;
            if (isRealModel(bucket.model)) {
              const model = day.models.get(bucket.model) ?? { tokens: 0, costUsd: 0 };
              model.tokens += tokens;
              model.costUsd += cost;
              day.models.set(bucket.model, model);
            }
            dayTotals.set(bucket.day, day);
            const own = ownDays.get(bucket.day) ?? { tokens: 0, costUsd: 0 };
            own.tokens += tokens;
            own.costUsd += cost;
            ownDays.set(bucket.day, own);
            if (bucket.day === today && bucket.hour !== null) {
              const hour = hourTotals.get(bucket.hour) ?? { tokens: 0, costUsd: 0 };
              hour.tokens += tokens;
              hour.costUsd += cost;
              hourTotals.set(bucket.hour, hour);
            }
          }
        }
        if (ownDays.size) {
          const daily = [...ownDays].map(([day, used]) => ({ day, ...used })).sort((a, b) => a.day.localeCompare(b.day));
          workspaceUsage.push({ id, name, daily });
        }
        return costUsd;
      };
      /** A live transcript's usage, from the ledger until a first count after a restart has caught up with it. */
      const countUsage = (id: string, name: string, transcript: string | null) => {
        if (!transcript) return { counted: null, costUsd: 0 };
        // Counting a large transcript the first time takes a while, so it runs behind the answer.
        void refreshLive(transcript, { id });
        const counted = tokens.peek(transcript);
        recordLive(transcript, { id, name });
        const saved = ledger.get(transcript);
        if ((!counted || counted.scanning) && saved) return { counted, costUsd: addUsage(id, name, saved.buckets) };
        if (counted?.scanning) counting = true;
        return { counted, costUsd: addUsage(id, name, counted?.buckets ?? []) };
      };
      const sessionRows = snapshotSessions.map((ws) => {
        const pid = sessions.get(ws.id)?.pid ?? null;
        const live = options.status(ws.id);
        const { counted, costUsd } = countUsage(ws.id, ws.name, options.transcript(ws.id));
        return {
          id: ws.id,
          name: ws.name,
          pid,
          status: live.status,
          cwd: ws.cwd,
          cwdMissing: !existsSync(ws.cwd),
          claudeSessionId: live.claudeSessionId,
          tokens: counted ? { ...counted.totals, counting: counted.scanning, costUsd } : null,
          processes: pid === null ? [] : subtree(procs, pid).map((p) => toSystemProcess(p, listening)),
          history: pid === null ? [] : history.get(ws.id),
        };
      });
      // Everything else the ledger holds: archived workspaces, and earlier sessions of live ones.
      const names = new Map(snapshotSessions.map((ws) => [ws.id, ws.name]));
      for (const entry of ledger.list()) {
        if (!live.has(entry.transcript)) addUsage(entry.workspaceId, names.get(entry.workspaceId) ?? entry.name, entry.buckets);
      }
      const trend = usageTrend(dayTotals, counting, [...unpriced].sort());
      const since = trend.daily[0].day;
      const workspaces = mergeWorkspaces(workspaceUsage)
        .map((w) => ({ ...w, daily: w.daily.filter((d) => d.day >= since) }))
        .filter((w) => w.daily.length);
      return {
        takenAt: new Date().toISOString(),
        helper: {
          pid: process.pid,
          uptimeSec: Math.round(process.uptime()),
          rssKb: Math.round(process.memoryUsage().rss / 1024),
          cpu: procs.find((p) => p.pid === process.pid)?.cpu ?? 0,
          port: options.port,
          node: process.version,
          commit: options.commit,
          managed,
          clients,
          logPath: paths.logFile,
          configPath: paths.configFile,
          extensionId: config.extensionId,
        },
        sessions: sessionRows,
        usage: { ...trend, hourly: usageByHour(hourTotals), workspaces },
        plan: options.planUsage?.() ?? { limits: [], updatedAt: null },
        warnings: findWarnings(sessionRows, config.limits),
        storage: { uploadsBytes: pathBytes(paths.uploadDir), logBytes: pathBytes(paths.logFile), dataBytes: pathBytes(paths.dataDir) },
        config: {
          defaultCwd: config.defaultCwd,
          promptsFile: config.promptsFile,
          promptsFiles: config.promptsFiles,
          templatesFile: config.templatesFile,
          defaultModel: config.defaultModel,
          claudeCommand: config.claudeCommand,
          claudeArgs: config.claudeArgs,
          repoRoots: config.repoRoots,
          repoDirs: config.repoDirs,
          watchRepos: config.watchRepos,
          limits: config.limits,
          pricing: config.pricing,
          jiraBaseUrl: config.jiraBaseUrl,
        },
        reviews: { fetchedAt: reviews.fetchedAt, count: reviews.items.length, error: reviews.error },
        setup: {
          promptsFileExists: existsSync(config.promptsFile),
          repoRoots: config.repoRoots.map((path) => ({ path, exists: existsSync(path) })),
          statusHooks: paths.hooksFile !== null,
          configProblems: config.problems,
        },
      };
    },

    async run(request) {
      switch (request.action) {
        case 'restartSession': {
          const session = sessions.get(request.id);
          if (!session) return { ok: true, message: 'No session was running; it starts when the workspace is opened.', reset: [request.id] };
          // Silenced first, so a panel attached to it is not told the shell exited (which closes the panel).
          session.silence();
          sessions.remove(request.id);
          return { ok: true, message: 'Session ended. It starts again, resuming the conversation, when the workspace is opened.', reset: [request.id] };
        }
        case 'killProcess':
          return killProcess(request.id, request.pid, request.force === true);
        case 'restartHelper':
          if (!(await options.isManaged()))
            return { ok: false, message: 'The helper was not started by launchd, so it cannot restart itself. Run npm run agent:start first.' };
          options.spawnDetached(launchctl('kickstart -k'));
          return { ok: true, message: 'Restarting. Every open terminal ends, and the panel reconnects in a few seconds.' };
        case 'stopHelper':
          if (!(await options.isManaged())) return { ok: false, message: 'The helper was not started by launchd. Stop it where you started it.' };
          options.spawnDetached(launchctl('bootout'));
          return { ok: true, message: 'Stopping. Run npm run agent:start to bring it back.' };
        case 'clearUploads': {
          const bytes = pathBytes(paths.uploadDir);
          let files = 0;
          if (existsSync(paths.uploadDir)) {
            for (const name of readdirSync(paths.uploadDir)) {
              files += readdirSync(join(paths.uploadDir, name)).length;
              rmSync(join(paths.uploadDir, name), { recursive: true, force: true });
            }
          }
          return { ok: true, message: `Removed ${files} file${files === 1 ? '' : 's'} (${megabytes(bytes)}).` };
        }
        case 'clearLog':
          try {
            truncateSync(paths.logFile, 0);
            return { ok: true, message: 'Log cleared.' };
          } catch (error) {
            return { ok: false, message: errorMessage(error) };
          }
        case 'pruneWorktrees':
          return pruneWorktrees();
        case 'applyUpdate': {
          if (!options.repoDir) return { ok: false, message: 'This copy of the app is not a git checkout, so it cannot update itself.' };
          const outcome = await applyUpdate(options.repoDir, (command) => options.runShell(`cd "${options.repoDir}" && ${command}`));
          // The new code only runs after a restart, which ends every terminal, so it is left to launchd and only when it manages us.
          if (outcome.ok && outcome.restart && !(await options.isManaged())) {
            return { ok: true, message: `${outcome.message.split(' The helper')[0]} Restart the helper by hand, then reload the extension.` };
          }
          if (outcome.ok && outcome.restart) options.spawnDetached(launchctl('kickstart -k'));
          return { ok: outcome.ok, message: outcome.message };
        }
        case 'checkGh': {
          const { output, ok } = await options.runShell('gh auth status 2>&1');
          return { ok, message: output.split('\n').slice(0, 4).join(' · ') || (ok ? 'gh is signed in.' : 'gh is not signed in.') };
        }
      }
    },

    async checkUpdates() {
      if (!options.repoDir) throw new Error('This copy of the app is not a git checkout, so it cannot check for updates.');
      return checkUpdates(options.repoDir);
    },

    timeline(id) {
      const path = options.transcript(id);
      return path ? readTimeline(path) : null;
    },

    log() {
      return tailLines(paths.logFile, LOG_TAIL_BYTES)?.join('\n') ?? '';
    },

    exportData() {
      return `${JSON.stringify({ exportedAt: new Date().toISOString(), workspaces: store.list() }, null, 2)}\n`;
    },

    async sample(now = Date.now()) {
      const procs = await readProcs();
      const running: string[] = [];
      for (const ws of store.list()) {
        const pid = sessions.get(ws.id)?.pid;
        if (pid == null) continue;
        running.push(ws.id);
        const tree = subtree(procs, pid);
        history.record(ws.id, { t: now, rssKb: tree.reduce((sum, p) => sum + p.rssKb, 0), cpu: tree.reduce((sum, p) => sum + p.cpu, 0) });
      }
      history.keepOnly(running);
      // The same timer keeps the ledger current, whether or not Settings is open.
      const live = liveTranscripts();
      tokens.keepOnly(live.keys());
      await Promise.all([...live].map(([transcript, owner]) => refreshLive(transcript, owner)));
      await settle();
    },
  };
}
