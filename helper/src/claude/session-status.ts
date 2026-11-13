import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, watch } from 'node:fs';
import { tailLines } from './tail';
import { dirname, join } from 'node:path';
import { parseActivityLine } from '../../../shared/sessions/activity';
import type { PastSession, WaitingOn, WorkspaceStatus } from '../../../shared/protocol/protocol';
import type { SessionFile } from '../../../shared/protocol/session-file';
import { hasRunningSubagent } from './activity';

export interface WorkspaceSession {
  status: WorkspaceStatus;
  /** What claude waits on while `status` is `needs_input`. */
  waiting: WaitingOn | null;
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

const SESSION_ID = /^[A-Za-z0-9_-]+$/;
const MISS_MS = 60_000;
const located = new Map<string, { path: string | null; at: number }>();

/**
 * Where a session's transcript is. The hook records the folder of the directory claude started in, but claude files
 * the conversation under the directory it is in, so a session that moved into a worktree (a quest does) or started
 * in one and was resumed elsewhere has its transcript in another project folder than the one recorded, and the recorded
 * path is missing while the conversation is there. Falls back to `<session id>.jsonl` in the other project folders, and
 * to null when it is nowhere, as for a transcript claude has deleted. A miss is remembered for a minute, because every
 * old session whose transcript is gone would otherwise look through every folder on each refresh.
 */
export function locateTranscript(session: Pick<SessionFile, 'session_id' | 'transcript_path'>, now = Date.now()): string | null {
  const recorded = session.transcript_path;
  if (!recorded) return null;
  if (existsSync(recorded)) return recorded;
  const id = session.session_id;
  if (!id || !SESSION_ID.test(id)) return null;
  const seen = located.get(id);
  if (seen && (seen.path ? existsSync(seen.path) : now - seen.at < MISS_MS)) return seen.path;
  let found: string | null = null;
  const projects = dirname(dirname(recorded));
  try {
    for (const folder of readdirSync(projects)) {
      const candidate = join(projects, folder, `${id}.jsonl`);
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  } catch {
    // No projects folder to look in.
  }
  located.set(id, { path: found, at: now });
  return found;
}

const MAX_CONTINUATIONS = 5;

/** Follows "continued in" links from a workspace's session to a newer session that was kept out for its id or directory. */
function followContinuations(session: SessionFile, strays: ReadonlyMap<string, SessionFile>): SessionFile {
  let current = session;
  for (let hop = 0; hop < MAX_CONTINUATIONS; hop++) {
    const transcript = locateTranscript(current);
    if (!transcript) break;
    const nextId = continuedInSession(transcript);
    const next = nextId ? strays.get(nextId) : undefined;
    if (!next || (next.started_at ?? '') <= (current.started_at ?? '')) break;
    current = next;
  }
  return current;
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
  // Sessions kept out of their workspace for starting elsewhere, by session id: a continuation may still belong to it.
  const strays = new Map<string, SessionFile>();
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
    if (session.status === 'ended' && session.transcript_path && !locateTranscript(session)) continue;
    // A session carrying the id of a workspace that has since gone is nobody's, so a conversation may continue in it.
    if (!home) strays.set(session.session_id, session);
    if (home && session.cwd && !isInside(session.cwd, home)) {
      strays.set(session.session_id, session);
      continue;
    }
    const current = newest.get(workspaceId);
    if (!current || (session.started_at ?? '') > (current.started_at ?? '')) newest.set(workspaceId, session);
  }

  // A fork started from another workspace's shell carries that workspace's id, but it is this conversation carried on.
  for (const [workspaceId, session] of newest) {
    newest.set(workspaceId, followContinuations(session, strays));
  }

  const result = new Map<string, WorkspaceSession>();
  for (const [workspaceId, session] of newest) {
    let status = LIVE_STATUSES.has(session.status ?? '') ? (session.status as WorkspaceStatus) : null;
    // claude is idle once it has answered, even with a subagent still running in the background.
    if (status === 'idle' && hasRunningSubagent(join(dir, `${session.session_id}.events.jsonl`))) status = 'working';
    const browserAt = session.browser_at ? Date.parse(session.browser_at) : NaN;
    const waiting = session.waiting;
    result.set(workspaceId, {
      status,
      waiting:
        status === 'needs_input' && waiting && typeof waiting.type === 'string' && typeof waiting.message === 'string'
          ? { type: waiting.type, message: waiting.message }
          : null,
      claudeSessionId: session.session_id!,
      browserAt: Number.isNaN(browserAt) ? null : browserAt,
      cwd: session.cwd ?? null,
      transcriptPath: locateTranscript(session) ?? session.transcript_path ?? null,
    });
  }
  return result;
}

const FIRST_PROMPT_BYTES = 64 * 1024;

/** The first prompt a session's event file recorded, from its head; null without one. */
function firstPrompt(eventsPath: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(eventsPath, 'r');
    const buffer = Buffer.alloc(FIRST_PROMPT_BYTES);
    const read = readSync(fd, buffer, 0, FIRST_PROMPT_BYTES, 0);
    for (const line of buffer.toString('utf8', 0, read).split('\n')) {
      const event = parseActivityLine(line);
      if (event?.event === 'UserPromptSubmit' && event.summary) return event.summary;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Every session of one workspace, newest first, for picking an earlier conversation. The same rules as
 * `readSessionStatus` keep out sessions started elsewhere; an ended one whose transcript is gone cannot be resumed.
 */
export function listWorkspaceSessions(dir: string, workspaceId: string, home: string | null): PastSession[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const sessions: PastSession[] = [];
  for (const name of names) {
    let session: SessionFile;
    try {
      session = JSON.parse(readFileSync(join(dir, name), 'utf8')) as SessionFile;
    } catch {
      continue;
    }
    if (session.cw_workspace_id !== workspaceId || !session.session_id || !session.started_at) continue;
    if (home && session.cwd && !isInside(session.cwd, home)) continue;
    if (session.status === 'ended' && session.transcript_path && !locateTranscript(session)) continue;
    sessions.push({
      id: session.session_id,
      startedAt: session.started_at,
      status: LIVE_STATUSES.has(session.status ?? '') ? (session.status as WorkspaceStatus) : null,
      firstPrompt: firstPrompt(join(dir, `${session.session_id}.events.jsonl`)),
    });
  }
  return sessions.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** The lines at the end of a claude transcript, oldest first. Only the end is read, since transcripts grow large. */
const transcriptTail = (path: string): string[] | null => tailLines(path, TRANSCRIPT_TAIL_BYTES);

/** The value of `field` on the newest transcript line that has a string for it. */
function lastTranscriptField(path: string, field: string): string | null {
  const lines = transcriptTail(path);
  if (!lines) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes(`"${field}"`)) continue;
    try {
      const value = (JSON.parse(lines[i]) as Record<string, unknown>)[field];
      if (typeof value === 'string' && value) return value;
    } catch {
      // A line cut off by a write in progress.
    }
  }
  return null;
}

/**
 * The directory of the newest message in a claude transcript. Claude records its current directory
 * on every message, so this follows it into a worktree, which the session file's `cwd` does not.
 */
export function lastTranscriptCwd(path: string): string | null {
  return lastTranscriptField(path, 'cwd');
}

/** The session a transcript was continued in (a fork, or a new session carrying the conversation on), if it records one. */
export function continuedInSession(path: string): string | null {
  return lastTranscriptField(path, 'continuedInSessionId');
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

/** Deletes state and event files nothing has touched in a month, so ended sessions do not pile up. */
export function pruneSessions(dir: string, now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.json') || name.endsWith('.jsonl'));
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
