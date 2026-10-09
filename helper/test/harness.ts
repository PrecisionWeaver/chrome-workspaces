import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL, TOKEN_PROTOCOL_PREFIX, type ControlToClient, type Prompt, type Repo, type ReviewRequest, type WorkspaceStatus } from '../../shared/protocol';
import { createApi } from '../src/api';
import { ControlHub } from '../src/control';
import { createGitService } from '../src/git';
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
  /** What the fake review poller reports; tests push into it. */
  reviews: ReviewRequest[];
  reviewRefreshes: number;
  prompts: Prompt[];
  /** When set, reading prompts fails with this message. */
  promptsError: string | null;
  repoDirs: Record<string, string>;
  repos: Repo[];
  /** Where each workspace's claude reports working, by workspace id. */
  workingDirs: Record<string, string>;
  /** What the fake `gh pr view` returns; null makes it fail with "gh failed". */
  prDetailsJson: string | null;
  prDetailsRequests: string[];
  url(path: string): string;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'cw-harness-'));
  const defaultCwd = mkdtempSync(join(tmpdir(), 'cw-cwd-'));
  const store = new WorkspaceStore(join(dir, 'workspaces.json'));
  const sessions = new SessionManager(10_000);
  const fakes = {
    statuses: {} as Record<string, WorkspaceStatus>,
    reviews: [] as ReviewRequest[],
    reviewRefreshes: 0,
    prompts: [] as Prompt[],
    promptsError: null as string | null,
    repoDirs: {} as Record<string, string>,
    repos: [] as Repo[],
    workingDirs: {} as Record<string, string>,
    prDetailsJson: null as string | null,
    prDetailsRequests: [] as string[],
  };
  const prDetails = async (url: string) => {
    fakes.prDetailsRequests.push(url);
    if (fakes.prDetailsJson === null) throw new Error('gh failed');
    return fakes.prDetailsJson;
  };
  const reviews = {
    state: () => ({ items: fakes.reviews, error: null, fetchedAt: null }),
    refresh: async () => {
      fakes.reviewRefreshes++;
    },
  };
  const prompts = () => {
    if (fakes.promptsError) throw new Error(fakes.promptsError);
    return fakes.prompts;
  };
  const statuses = () => fakes.statuses;
  const control = new ControlHub({ store, sessions, defaultCwd, statuses, reviews, prompts, prDetails, repoDirs: fakes.repoDirs, repos: () => fakes.repos, git: createGitService(), workingDir: (id) => fakes.workingDirs[id] ?? null });
  const auth = { token: TOKEN, allowedOrigins: [ORIGIN] };
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    auth,
    sessions,
    control,
    api: createApi({ auth, store, control, sessions, defaultCwd, statuses, reviews, repoDirs: fakes.repoDirs }),
  });
  return Object.assign(fakes, {
    server,
    store,
    sessions,
    control,
    defaultCwd,
    url: (path: string) => `http://127.0.0.1:${server.port}${path}`,
    close: async () => {
      await server.close();
      sessions.killAll();
    },
  });
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
