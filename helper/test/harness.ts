import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL, TOKEN_PROTOCOL_PREFIX, type ControlToClient, type WorkspaceStatus } from '../../shared/protocol';
import { createApi } from '../src/api';
import { ControlHub } from '../src/control';
import { startServer, type RunningServer } from '../src/server';
import { SessionManager } from '../src/session';
import { WorkspaceStore } from '../src/workspace-store';

export const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
export const TOKEN = 'a'.repeat(64);

export interface Harness {
  server: RunningServer;
  store: WorkspaceStore;
  sessions: SessionManager;
  control: ControlHub;
  defaultCwd: string;
  statuses: Record<string, WorkspaceStatus>;
  url(path: string): string;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'cw-harness-'));
  const defaultCwd = mkdtempSync(join(tmpdir(), 'cw-cwd-'));
  const store = new WorkspaceStore(join(dir, 'workspaces.json'));
  const sessions = new SessionManager(10_000);
  const statuses: Record<string, WorkspaceStatus> = {};
  const control = new ControlHub({ store, sessions, defaultCwd, statuses: () => statuses });
  const auth = { token: TOKEN, allowedOrigins: [ORIGIN] };
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    auth,
    sessions,
    control,
    api: createApi({ auth, store, control, sessions, defaultCwd, statuses: () => statuses }),
  });
  return {
    server,
    store,
    sessions,
    control,
    defaultCwd,
    statuses,
    url: (path) => `http://127.0.0.1:${server.port}${path}`,
    close: async () => {
      await server.close();
      sessions.killAll();
    },
  };
}

export function connectControl(h: Harness): { ws: WebSocket; messages: ControlToClient[] } {
  const ws = new WebSocket(`ws://127.0.0.1:${h.server.port}/control`, [PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${TOKEN}`], { origin: ORIGIN });
  const messages: ControlToClient[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString()) as ControlToClient));
  return { ws, messages };
}

export function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => ws.on('open', () => resolve()));
}
