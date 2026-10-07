import { timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute } from 'node:path';
import type { WorkspaceStatus } from '../../shared/protocol';
import type { AuthPolicy } from './auth';
import type { ControlHub } from './control';
import type { SessionManager } from './session';
import type { WorkspaceStore } from './workspace-store';

export interface ApiOptions {
  auth: AuthPolicy;
  store: WorkspaceStore;
  control: ControlHub;
  sessions: SessionManager;
  defaultCwd: string;
  statuses: () => Record<string, WorkspaceStatus>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const MAX_BODY = 64 * 1024;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** HTTP API for local tools (devspace, Mission Control). Every request needs the bearer token. */
export function createApi(options: ApiOptions): Handler {
  return (req, res) => {
    handle(req, options)
      .then(({ status, body }) => send(res, status, body))
      .catch((error: unknown) => {
        if (error instanceof HttpError) send(res, error.status, { error: error.message });
        else send(res, 500, { error: error instanceof Error ? error.message : String(error) });
      });
  };
}

async function handle(req: IncomingMessage, options: ApiOptions): Promise<{ status: number; body: unknown }> {
  // Browsers attach Origin to cross-site requests; nothing but our extension may call us from one.
  const origin = req.headers.origin;
  if (origin && !options.auth.allowedOrigins.includes(origin)) throw new HttpError(403, 'forbidden origin');
  if (!hasBearer(req, options.auth.token)) throw new HttpError(401, 'unauthorized');

  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const { store, control } = options;

  if (pathname === '/workspaces' && req.method === 'GET') {
    return { status: 200, body: { workspaces: store.list(), statuses: options.statuses() } };
  }

  if (pathname === '/workspaces' && req.method === 'POST') {
    const input = parseCreate(await readJson(req), options.defaultCwd);
    const existing = input.ticket ? store.findByTicket(input.ticket) : undefined;
    if (existing) {
      const delivered = control.send({ type: 'focus', id: existing.id });
      return { status: 200, body: { workspace: existing, created: false, delivered } };
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

  const one = pathname.match(/^\/workspaces\/(ws-[0-9a-f]{8})$/);
  if (one && req.method === 'DELETE') {
    if (!store.get(one[1])) throw new HttpError(404, 'unknown workspace');
    options.sessions.remove(one[1]);
    store.remove(one[1]);
    return { status: 200, body: { ok: true } };
  }

  throw new HttpError(404, 'not found');
}

function hasBearer(req: IncomingMessage, token: string): boolean {
  const match = req.headers.authorization?.match(/^Bearer (\S+)$/);
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function parseCreate(body: unknown, defaultCwd: string) {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'expected a JSON object');
  const { name, ticket, cwd, url } = body as Record<string, unknown>;

  const ticketValue = optionalString(ticket, 'ticket', 64);
  const nameValue = optionalString(name, 'name', 80) ?? ticketValue;
  if (!nameValue) throw new HttpError(400, 'name or ticket is required');

  const cwdValue = optionalString(cwd, 'cwd', 1024) ?? defaultCwd;
  if (!isAbsolute(cwdValue) || !isDirectory(cwdValue)) throw new HttpError(400, `cwd is not an existing absolute directory: ${cwdValue}`);

  const urlValue = optionalString(url, 'url', 2048);
  if (urlValue && !/^https?:\/\//i.test(urlValue)) throw new HttpError(400, 'url must be http(s)');

  return { name: nameValue, ticket: ticketValue, cwd: cwdValue, url: urlValue };
}

function optionalString(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw new HttpError(400, `${field} must be a string of at most ${max} characters`);
  return value;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
