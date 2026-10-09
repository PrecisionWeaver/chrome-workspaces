import { existsSync, readdirSync, readFileSync, watch } from 'node:fs';
import { join } from 'node:path';
import type { WorkspaceStatus } from '../../shared/protocol';

export interface McWorkspaceStatus {
  status: WorkspaceStatus;
  claudeSessionId: string;
  /** Last Claude in Chrome tool call (epoch ms). */
  browserAt: number | null;
  /** The directory claude last reported working in; a worktree once it has entered one. */
  cwd: string | null;
}

interface McSessionFile {
  session_id?: string;
  cw_workspace_id?: string | null;
  status?: string;
  started_at?: string;
  browser_at?: string;
  cwd?: string;
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
    result.set(workspaceId, { status, claudeSessionId: session.session_id!, browserAt: Number.isNaN(browserAt) ? null : browserAt, cwd: session.cwd ?? null });
  }
  return result;
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
