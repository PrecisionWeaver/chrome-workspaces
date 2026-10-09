import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, rmSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findWarnings } from '../../shared/guardrails';
import type { AdminAction, ReviewsState, SystemSnapshot, WorkspaceStatus } from '../../shared/protocol';
import type { HelperConfig } from './config';
import type { SessionManager } from './session';
import { TranscriptTokens } from './tokens';
import { pathBytes, readListening, readProcesses, subtree, toSystemProcess, type Proc } from './system';
import type { WorkspaceStore } from './workspace-store';

const execFileAsync = promisify(execFile);

export const AGENT_LABEL = 'com.chrome-workspaces.helper';
const LOG_TAIL_BYTES = 64 * 1024;

export interface AdminOptions {
  sessions: SessionManager;
  store: WorkspaceStore;
  config: HelperConfig;
  paths: { dataDir: string; uploadDir: string; logFile: string; configFile: string; workspacesFile: string };
  port: number;
  /** The helper's own commit, when it can be read. */
  commit: string | null;
  status: (id: string) => { status: WorkspaceStatus; claudeSessionId: string | null };
  /** The transcript of the workspace's current claude session, for counting its tokens. */
  transcript: (id: string) => string | null;
  /** Runs a command line in a login shell, resolving with its output and whether it exited cleanly. */
  runShell: (command: string) => Promise<{ output: string; ok: boolean }>;
  /** Starts a command that outlives the helper. */
  spawnDetached: (command: string) => void;
  /** Whether launchd runs this process. */
  isManaged: () => Promise<boolean>;
  processes?: () => Promise<Proc[]>;
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
  exportData(): string;
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export function defaultRunShell(shell: string) {
  return async (command: string): Promise<{ output: string; ok: boolean }> => {
    try {
      const { stdout, stderr } = await execFileAsync(shell, ['-l', '-c', command], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      return { output: `${stdout}${stderr}`.trim(), ok: true };
    } catch (error) {
      const { stdout, stderr } = error as { stdout?: string; stderr?: string };
      return { output: `${stdout ?? ''}${stderr ?? ''}`.trim() || (error instanceof Error ? error.message : String(error)), ok: false };
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

export function createAdmin(options: AdminOptions): AdminService {
  const { sessions, store, config, paths } = options;
  const readProcs = options.processes ?? readProcesses;
  const tokens = new TranscriptTokens();

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
    return { ok: true, message: `Checked ${roots.size} repositor${roots.size === 1 ? 'y' : 'ies'}; removed ${pruned} stale worktree record${pruned === 1 ? '' : 's'}.` };
  }

  return {
    async snapshot({ reviews, clients }) {
      const [procs, listening, managed] = await Promise.all([readProcs(), readListening(), options.isManaged()]);
      const snapshotSessions = store.list();
      tokens.keepOnly(snapshotSessions.flatMap((ws) => options.transcript(ws.id) ?? []));
      const sessionRows = snapshotSessions.map((ws) => {
        const pid = sessions.get(ws.id)?.pid ?? null;
        const live = options.status(ws.id);
        const transcript = options.transcript(ws.id);
        // Counting a large transcript the first time takes a while, so it runs behind the answer.
        if (transcript) void tokens.refresh(transcript);
        const counted = transcript ? tokens.peek(transcript) : null;
        return {
          id: ws.id,
          name: ws.name,
          pid,
          status: live.status,
          cwd: ws.cwd,
          cwdMissing: !existsSync(ws.cwd),
          claudeSessionId: live.claudeSessionId,
          tokens: counted ? { ...counted.totals, counting: counted.scanning } : null,
          processes: pid === null ? [] : subtree(procs, pid).map((p) => toSystemProcess(p, listening)),
        };
      });
      return {
        takenAt: new Date().toISOString(),
        helper: {
          pid: process.pid,
          uptimeSec: Math.round(process.uptime()),
          rssKb: Math.round(process.memoryUsage().rss / 1024),
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
        warnings: findWarnings(sessionRows, config.limits),
        storage: { uploadsBytes: pathBytes(paths.uploadDir), logBytes: pathBytes(paths.logFile), dataBytes: pathBytes(paths.dataDir) },
        config: {
          defaultCwd: config.defaultCwd,
          promptsFile: config.promptsFile,
          defaultModel: config.defaultModel,
          repoRoots: config.repoRoots,
          repoDirs: config.repoDirs,
          watchRepos: config.watchRepos,
          limits: config.limits,
        },
        reviews: { fetchedAt: reviews.fetchedAt, count: reviews.items.length, error: reviews.error },
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
          if (!(await options.isManaged())) return { ok: false, message: 'The helper was not started by launchd, so it cannot restart itself. Run npm run agent:start first.' };
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
            return { ok: false, message: error instanceof Error ? error.message : String(error) };
          }
        case 'pruneWorktrees':
          return pruneWorktrees();
        case 'checkGh': {
          const { output, ok } = await options.runShell('gh auth status 2>&1');
          return { ok, message: output.split('\n').slice(0, 4).join(' · ') || (ok ? 'gh is signed in.' : 'gh is not signed in.') };
        }
      }
    },

    log() {
      let fd: number | undefined;
      try {
        fd = openSync(paths.logFile, 'r');
        const { size } = fstatSync(fd);
        const length = Math.min(size, LOG_TAIL_BYTES);
        const buffer = Buffer.alloc(length);
        readSync(fd, buffer, 0, length, size - length);
        const text = buffer.toString('utf8');
        // A tail that starts mid-file begins with a partial line.
        return size > length ? text.slice(text.indexOf('\n') + 1) : text;
      } catch {
        return '';
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },

    exportData() {
      return `${JSON.stringify({ exportedAt: new Date().toISOString(), workspaces: store.list() }, null, 2)}\n`;
    },
  };
}
