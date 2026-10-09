import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceStatus } from '../../shared/protocol';

export interface McWorkspaceStatus {
  status: WorkspaceStatus;
  claudeSessionId: string;
  /** Last Claude in Chrome tool call (epoch ms). */
  browserAt: number | null;
  /** The directory claude started in. It does not follow claude into a worktree; see `lastTranscriptCwd`. */
  cwd: string | null;
  /** claude's conversation log, which records the directory of every message. */
  transcriptPath: string | null;
}

interface McSessionFile {
  session_id?: string;
  cw_workspace_id?: string | null;
  status?: string;
  started_at?: string;
  browser_at?: string;
  cwd?: string;
  transcript_path?: string;
}

const LIVE_STATUSES = new Set(['needs_input', 'working', 'idle']);

/** Claude Mission Control's hook writes one file per Claude session; this groups them by workspace. */
export function readMcStatus(dir: string): Map<string, McWorkspaceStatus> {
  const newest = new Map<string, McSessionFile>();
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return new Map();
  }

  for (const name of names) {
    let session: McSessionFile;
    try {
      session = JSON.parse(readFileSync(join(dir, name), 'utf8')) as McSessionFile;
    } catch {
      continue;
    }
    const workspaceId = session.cw_workspace_id;
    if (!workspaceId || !session.session_id) continue;
    const current = newest.get(workspaceId);
    if (!current || (session.started_at ?? '') > (current.started_at ?? '')) newest.set(workspaceId, session);
  }

  const result = new Map<string, McWorkspaceStatus>();
  for (const [workspaceId, session] of newest) {
    const status = LIVE_STATUSES.has(session.status ?? '') ? (session.status as WorkspaceStatus) : null;
    const browserAt = session.browser_at ? Date.parse(session.browser_at) : NaN;
    result.set(workspaceId, { status, claudeSessionId: session.session_id!, browserAt: Number.isNaN(browserAt) ? null : browserAt, cwd: session.cwd ?? null, transcriptPath: session.transcript_path ?? null });
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

/** Calls `onChange` (debounced) whenever Mission Control's state changes. Returns a stop function. */
export function watchMcStatus(dir: string, onChange: () => void, debounceMs = 200): () => void {
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
