import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import { isBranchName } from '../../../shared/workspaces/branch-name';
import { MAX_PROMPT_LENGTH } from '../../../shared/protocol/protocol';
import type { WaitingOn, WorkspaceStatus } from '../../../shared/protocol/workspace';
import { tokenMatches, type AuthPolicy } from './auth';
import { isDirectory } from '../platform/config';
import { asPaste, MAX_PASTE_LENGTH } from '../pty/paste';
import type { ControlHub, ReviewSource } from '../control/hub';
import type { GitService } from '../git/git';
import { isPullRequestUrl, prWorkspace } from '../git/pr-workspace';
import type { SessionManager } from '../pty/session';
import type { HistoryStore } from '../store/history';
import type { WorkspaceStore } from '../store/workspace-store';
import { errorMessage } from '../../../shared/protocol/errors';

export interface ApiOptions {
  auth: AuthPolicy;
  store: WorkspaceStore;
  control: ControlHub;
  sessions: SessionManager;
  defaultCwd: string;
  statuses: () => Record<string, WorkspaceStatus>;
  /** What each waiting workspace waits on; only workspaces at `needs_input` have an entry. */
  waiting: () => Record<string, WaitingOn>;
  history: Pick<HistoryStore, 'list'>;
  /** How often a `wait` looks at the status again; tests shorten it. */
  waitPollMs?: number;
  reviews: Pick<ReviewSource, 'state'>;
  repoDirs: Record<string, string>;
  git: Pick<GitService, 'addWorktree'>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const MAX_BODY = 64 * 1024;
const DEFAULT_WAIT_SECONDS = 600;
const MAX_WAIT_SECONDS = 3600;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** HTTP API for local tools (shell helpers and other local tools). Every request needs the bearer token. */
export function createApi(options: ApiOptions): Handler {
  return (req, res) => {
    handle(req, options)
      .then(({ status, body }) => send(res, status, body))
      .catch((error: unknown) => {
        if (error instanceof HttpError) send(res, error.status, { error: error.message });
        else send(res, 500, { error: errorMessage(error) });
      });
  };
}

async function handle(req: IncomingMessage, options: ApiOptions): Promise<{ status: number; body: unknown }> {
  // Browsers attach Origin to cross-site requests; nothing but our extension may call us from one.
  const origin = req.headers.origin;
  if (origin && !options.auth.allowedOrigins.includes(origin)) throw new HttpError(403, 'forbidden origin');
  if (!hasBearer(req, options.auth.token)) throw new HttpError(401, 'unauthorized');

  const { pathname, searchParams } = new URL(req.url ?? '/', 'http://localhost');
  const { store, control } = options;

  if (pathname === '/workspaces' && req.method === 'GET') {
    return { status: 200, body: { workspaces: store.list(), statuses: options.statuses() } };
  }

  if (pathname === '/workspaces' && req.method === 'POST') {
    const { worktree, ...input } = parseCreate(await readJson(req), options);
    // A PR workspace is matched by PR only: a review of a ticket's PR is separate from working on the ticket.
    // Found before any worktree is made, so a repeat request leaves nothing behind.
    const existing = input.pr ? store.findByPr(input.pr) : input.ticket ? store.findByTicket(input.ticket) : undefined;
    if (existing) {
      const delivered = control.send({ type: 'focus', id: existing.id });
      return { status: 200, body: { workspace: existing, created: false, delivered } };
    }
    if (worktree) {
      try {
        input.cwd = await options.git.addWorktree(input.cwd, worktree);
      } catch (error) {
        throw new HttpError(400, `could not make a worktree for ${worktree}: ${errorMessage(error)}`);
      }
    }
    const workspace = store.create(input);
    const delivered = control.send({ type: 'open', id: workspace.id });
    return { status: 201, body: { workspace, created: true, delivered } };
  }

  const focus = pathname.match(/^\/workspaces\/(ws-[0-9a-f]{8})\/focus$/);
  if (focus && req.method === 'POST') {
    if (!store.get(focus[1])) throw new HttpError(404, 'unknown workspace');
    if (!control.send({ type: 'focus', id: focus[1] })) throw new HttpError(409, 'extension not connected');
    return { status: 200, body: { ok: true } };
  }

  const send = pathname.match(/^\/workspaces\/(ws-[0-9a-f]{8})\/send$/);
  if (send && req.method === 'POST') {
    if (!store.get(send[1])) throw new HttpError(404, 'unknown workspace');
    const body = await readJson(req);
    const text = typeof body === 'object' && body !== null ? (body as { text?: unknown }).text : undefined;
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
    if (text.length > MAX_PASTE_LENGTH) throw new HttpError(400, `text is longer than ${MAX_PASTE_LENGTH} characters`);
    const session = options.sessions.get(send[1]);
    if (!session || session.exited) throw new HttpError(409, 'that workspace has no running terminal; open it first');
    // Pasted, never submitted: the person decides whether to send it.
    session.write(asPaste(text));
    return { status: 200, body: { ok: true } };
  }

  const wait = pathname.match(/^\/workspaces\/(ws-[0-9a-f]{8})\/wait$/);
  if (wait && req.method === 'GET') {
    if (!store.get(wait[1])) throw new HttpError(404, 'unknown workspace');
    return { status: 200, body: await waitForTurn(req, wait[1], waitSeconds(searchParams.get('timeout')), options) };
  }

  if (pathname === '/archived' && req.method === 'GET') {
    return { status: 200, body: { entries: options.history.list() } };
  }

  const restore = pathname.match(/^\/archived\/(h-[0-9a-f]{8})\/restore$/);
  if (restore && req.method === 'POST') {
    // The same restore as the panel's, in a window of its own.
    const workspace = control.restore(restore[1]);
    if (!workspace) throw new HttpError(404, 'unknown archived workspace');
    return { status: 201, body: { workspace, delivered: control.clientCount > 0 } };
  }

  const one = pathname.match(/^\/workspaces\/(ws-[0-9a-f]{8})$/);
  if (one && req.method === 'GET') {
    const workspace = store.get(one[1]);
    if (!workspace) throw new HttpError(404, 'unknown workspace');
    return { status: 200, body: { workspace, status: options.statuses()[one[1]] ?? null, waiting: options.waiting()[one[1]] ?? null } };
  }
  if (one && req.method === 'DELETE') {
    if (!store.get(one[1])) throw new HttpError(404, 'unknown workspace');
    // The same archive as the panel's, so the workspace can be restored from Archived.
    control.remove(one[1]);
    return { status: 200, body: { ok: true } };
  }

  throw new HttpError(404, 'not found');
}

function waitSeconds(value: string | null): number {
  if (value === null) return DEFAULT_WAIT_SECONDS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > MAX_WAIT_SECONDS) throw new HttpError(400, `timeout must be 0 to ${MAX_WAIT_SECONDS} seconds`);
  return seconds;
}

/**
 * Answers once the workspace's claude has stopped for the person: waiting on input, or idle after a turn. A workspace
 * with no status yet (its claude has not started) keeps waiting, so a script can create one and wait on it at once.
 */
function waitForTurn(req: IncomingMessage, id: string, seconds: number, options: ApiOptions) {
  const { store, statuses, waiting, waitPollMs = 500 } = options;
  const deadline = Date.now() + seconds * 1000;
  return new Promise<{ status: WorkspaceStatus; waiting: WaitingOn | null; timedOut: boolean }>((resolve, reject) => {
    const look = (): void => {
      if (!store.get(id)) {
        finish(() => reject(new HttpError(404, 'that workspace was archived while waiting')));
        return;
      }
      const status = statuses()[id] ?? null;
      const stopped = status === 'needs_input' || status === 'idle';
      if (stopped || Date.now() >= deadline) finish(() => resolve({ status, waiting: waiting()[id] ?? null, timedOut: !stopped }));
    };
    const timer = setInterval(look, waitPollMs);
    // A caller that gave up is not waited for.
    const gone = (): void => finish(() => reject(new HttpError(499, 'client closed the request')));
    const finish = (settle: () => void): void => {
      clearInterval(timer);
      req.off('close', gone);
      settle();
    };
    req.on('close', gone);
    look();
  });
}

function hasBearer(req: IncomingMessage, token: string): boolean {
  const match = req.headers.authorization?.match(/^Bearer (\S+)$/);
  return match !== null && match !== undefined && tokenMatches(match[1], token);
}

function parseCreate(body: unknown, { defaultCwd, repoDirs, reviews }: ApiOptions) {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'expected a JSON object');
  const { name, ticket, cwd, url, pr, prompt, worktree } = body as Record<string, unknown>;
  const worktreeValue = optionalString(worktree, 'worktree', 100);
  if (worktreeValue !== undefined && worktreeValue !== null && !isBranchName(worktreeValue)) throw new HttpError(400, 'worktree must be a branch name');
  const promptValue = optionalString(prompt, 'prompt', MAX_PROMPT_LENGTH);

  const prValue = optionalString(pr, 'pr', 2048);
  if (prValue) {
    if (!isPullRequestUrl(prValue)) throw new HttpError(400, 'pr must be a GitHub pull request url');
    const base = prWorkspace(prValue, { reviews: reviews.state().items, repoDirs, defaultCwd });
    return { ...base, name: optionalString(name, 'name', 80) ?? base.name, prompt: promptValue, worktree: worktreeValue };
  }

  const ticketValue = optionalString(ticket, 'ticket', 64);
  const nameValue = optionalString(name, 'name', 80) ?? ticketValue;
  if (!nameValue) throw new HttpError(400, 'name or ticket is required');

  const cwdValue = optionalString(cwd, 'cwd', 1024) ?? defaultCwd;
  if (!isAbsolute(cwdValue) || !isDirectory(cwdValue)) throw new HttpError(400, `cwd is not an existing absolute directory: ${cwdValue}`);

  const urlValue = optionalString(url, 'url', 2048);
  if (urlValue && !/^https?:\/\//i.test(urlValue)) throw new HttpError(400, 'url must be http(s)');

  return { name: nameValue, ticket: ticketValue, cwd: cwdValue, url: urlValue, pr: null, prompt: promptValue, worktree: worktreeValue };
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${field} must be a string of at most ${max} characters`);
  return value;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
