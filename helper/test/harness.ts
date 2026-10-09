import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL, TOKEN_PROTOCOL_PREFIX, type ControlToClient, type Prompt, type Repo, type ReviewRequest, type WorkspaceStatus } from '../../shared/protocol';
import { createApi } from '../src/api';
import { createAdmin } from '../src/admin';
import { ControlHub } from '../src/control';
import { createGitService } from '../src/git';
import { HistoryStore } from '../src/history';
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
  /** Commands the admin service started detached, instead of running them. */
  spawned: string[];
  /** What the fake `gh pr view` for a branch returns; null means the branch has no pull request. */
  branchPrJson: string | null;
  /** The claude session each workspace is on, by id, for restoring. */
  resumeIds: Record<string, string>;
  /** The claude transcript of each workspace, by id, for token counts. */
  transcripts: Record<string, string>;
  /** Whether the fake launchd manages the helper. */
  managed: boolean;
  /** Where uploads, the log and the data folder are for admin tests. */
  dataDir: string;
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
    spawned: [] as string[],
    branchPrJson: null as string | null,
    resumeIds: {} as Record<string, string>,
    transcripts: {} as Record<string, string>,
    managed: true,
    dataDir: dir,
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
  const admin = createAdmin({
    sessions,
    store,
    config: { extensionId: 'abcdefghijklmnopabcdefghijklmnop', defaultCwd, promptsFile: '/p.md', defaultModel: null, limits: { memoryWarnMb: 4096, idleServerHours: 4 }, pricing: { opus: { input: 10, output: 50 } }, repoRoots: [], repoDirs: {}, watchRepos: [] },
    paths: { dataDir: dir, uploadDir: join(dir, 'uploads'), logFile: join(dir, 'helper.log'), configFile: join(dir, 'config.json'), workspacesFile: join(dir, 'workspaces.json') },
    port: 4178,
    commit: 'abc1234',
    status: (id) => ({ status: fakes.statuses[id] ?? null, claudeSessionId: null }),
    transcript: (id) => fakes.transcripts[id] ?? null,
    runShell: async (command) => ({ output: `ran: ${command}`, ok: true }),
    spawnDetached: (command) => fakes.spawned.push(command),
    isManaged: async () => fakes.managed,
  });
  const control = new ControlHub({ store, sessions, defaultCwd, statuses, reviews, prompts, prDetails, branchPr: async () => {
      if (fakes.branchPrJson === null) throw new Error('no pull requests found for branch "x"');
      return fakes.branchPrJson;
    }, repoDirs: fakes.repoDirs, repos: () => fakes.repos, git: createGitService(), admin, history: new HistoryStore(join(dir, 'history.json')), resumeId: (id) => fakes.resumeIds[id] ?? null, workingDir: (id) => fakes.workingDirs[id] ?? null });
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
