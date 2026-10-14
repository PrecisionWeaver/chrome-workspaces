import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceStatus } from '../../shared/protocol';
import type { SessionFile } from '../../shared/session-file';

export interface WorkspaceSession {
  status: WorkspaceStatus;
  claudeSessionId: string;
  /** Last Claude in Chrome tool call (epoch ms). */
  browserAt: number | null;
  /** The directory claude started in. It does not follow claude into a worktree; see `lastTranscriptCwd`. */
  cwd: string | null;
  /** claude's conversation log, which records the directory of every message. */
  transcriptPath: string | null;
}

function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(directory.endsWith('/') ? directory : `${directory}/`);
}

const LIVE_STATUSES = new Set(['needs_input', 'working', 'idle']);

/**
 * The hook in hooks/session-state.ts writes one file per Claude session; this groups them by workspace.
 * With `workspaceCwds` (workspace id → directory), a session started elsewhere is not the workspace's:
 * a `claude` run from its shell in another project inherits its id, and would otherwise be the one resumed.
 * An ended session that never recorded a message has nothing to resume, so it does not stand in for the last real one.
 */
export function readSessionStatus(dir: string, workspaceCwds: ReadonlyMap<string, string> = new Map()): Map<string, WorkspaceSession> {
  const newest = new Map<string, SessionFile>();
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return new Map();
  }

  for (const name of names) {
    let session: SessionFile;
    try {
      session = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SessionFile;
    } catch {
      continue;
    }
    const workspaceId = session.cw_workspace_id;
    if (!workspaceId || !session.session_id) continue;
    const home = workspaceCwds.get(workspaceId);
    if (home && session.cwd && !isInside(session.cwd, home)) continue;
    if (session.status === 'ended' && session.transcript_path && !existsSync(session.transcript_path)) continue;
    const current = newest.get(workspaceId);
    if (!current || (session.started_at ?? '') > (current.started_at ?? '')) newest.set(workspaceId, session);
  }

  const result = new Map<string, WorkspaceSession>();
  for (const [workspaceId, session] of newest) {
    const status = LIVE_STATUSES.has(session.status ?? '') ? (session.status as WorkspaceStatus) : null;
    const browserAt = session.browser_at ? Date.parse(session.browser_at) : NaN;
    result.set(workspaceId, {
      status,
      claudeSessionId: session.session_id!,
      browserAt: Number.isNaN(browserAt) ? null : browserAt,
      cwd: session.cwd ?? null,
      transcriptPath: session.transcript_path ?? null,
    });
  }
  return result;
}

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/**
 * The directory of the newest message in a claude transcript. Claude records its current directory
 * on every message, so this follows it into a worktree, which the session file's `cwd` does not.
 * Only the end of the file is read, since transcripts grow large.
 */
export function lastTranscriptCwd(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // A tail that starts mid-file begins with a partial line.
    if (size > length) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"cwd"')) continue;
      try {
        const { cwd } = JSON.parse(lines[i]) as { cwd?: unknown };
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        // A line cut off by a write in progress.
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Calls `onChange` (debounced) whenever a session's state file changes. Returns a stop function. */
export function watchSessionStatus(dir: string, onChange: () => void, debounceMs = 200): () => void {
  if (!existsSync(dir)) return () => {};
  let timer: NodeJS.Timeout | undefined;
  const watcher = watch(dir, () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Deletes state files nothing has touched in a month, so ended sessions do not pile up. */
export function pruneSessions(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return;
  }
  for (const name of names) {
    try {
      if (now - statSync(join(dir, name)).mtimeMs > RETENTION_MS) rmSync(join(dir, name), { force: true });
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/**
 * Brings over the session ids that Claude Mission Control recorded before this app wrote its own, so a workspace
 * that was open before the upgrade still resumes its conversation. Those sessions are over, so no status comes
 * with them, and a file that already exists is left alone. Returns how many were imported.
 */
export function importLegacySessions(legacyDir: string, dir: string, now = Date.now()): number {
  let names: string[];
  try {
    names = readdirSync(legacyDir).filter((name) => name.endsWith('.json'));
  } catch {
    return 0;
  }
  let imported = 0;
  for (const name of names) {
    try {
      const from = join(legacyDir, name);
      if (existsSync(join(dir, name)) || now - statSync(from).mtimeMs > RETENTION_MS) continue;
      const old = JSON.parse(readFileSync(from, 'utf8')) as SessionFile;
      if (!old.cw_workspace_id || !old.session_id || !/^[A-Za-z0-9_-]+$/.test(old.session_id)) continue;
      const { session_id, cw_workspace_id, started_at, cwd, transcript_path, browser_at } = old;
      writeFileSync(join(dir, name), JSON.stringify({ session_id, cw_workspace_id, started_at, cwd, transcript_path, browser_at, status: 'ended' }, null, 2), {
        mode: 0o600,
      });
      imported++;
    } catch {
      // Unreadable, or not ours to copy.
    }
  }
  return imported;
}
