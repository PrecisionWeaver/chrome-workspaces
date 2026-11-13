import { join } from 'node:path';
import type { AdminAction, PlanUsage, ReviewsState, SystemSnapshot, UpdateStatus, WorkspaceStatus } from '../../../shared/protocol/protocol';
import { tailLines } from '../claude/tail';
import { readTimeline } from '../claude/timeline';
import { TranscriptTokens } from '../claude/tokens';
import { UsageLedger } from '../claude/usage-ledger';
import type { HelperConfig } from '../platform/config';
import { type Proc, readProcesses, subtree } from '../platform/system';
import type { SessionManager } from '../pty/session';
import { ResourceHistory } from '../store/resource-history';
import type { WorkspaceStore } from '../store/workspace-store';
import { checkUpdates, runAction } from './actions';
import { createLedgerSync } from './ledger-sync';
import { buildSnapshot } from './snapshot';

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

/** The Settings service: snapshots, actions, the log, the timeline and the resource samples, over one set of counters. */
export function createAdmin(options: AdminOptions): AdminService {
  const { sessions, store, paths } = options;
  const readProcs = options.processes ?? readProcesses;
  // Live transcripts only: anything else is counted once into the ledger and then read from there.
  const tokens = new TranscriptTokens();
  const ledger = new UsageLedger(join(paths.dataDir, USAGE_LEDGER_FILE));
  const history = new ResourceHistory();
  const sync = createLedgerSync({
    workspaces: () => store.list(),
    transcript: (id) => options.transcript(id),
    archived: () => options.archived?.() ?? [],
    tokens,
    ledger,
  });
  const context = { options, readProcs, tokens, ledger, history, sync };

  return {
    snapshot: (extra) => buildSnapshot(context, extra),

    run: (request) => runAction(context, request),

    checkUpdates: () => checkUpdates(options.repoDir),

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
      const live = sync.liveTranscripts();
      tokens.keepOnly(live.keys());
      await Promise.all([...live].map(([transcript, owner]) => sync.refreshLive(transcript, owner)));
      await sync.settle();
    },
  };
}
