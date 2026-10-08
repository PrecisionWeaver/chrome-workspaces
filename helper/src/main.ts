import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { WorkspaceStatus } from '../../shared/protocol';
import { createApi } from './api';
import { DATA_DIR, HOST, loadConfig, MC_STATE_DIR, PORT, SCROLLBACK_LIMIT } from './config';
import { ControlHub } from './control';
import { launchSpec } from './launch';
import { readMcStatus, watchMcStatus, type McWorkspaceStatus } from './mc-status';
import { GH_PR_DETAILS } from './pr-details';
import { readPrompts } from './prompts';
import { createGitService } from './git';
import { listRepos } from './repos';
import { GH_REVIEW_REQUESTS, ghWatchedPrs, ReviewsPoller } from './reviews';
import { startServer } from './server';
import { SessionManager } from './session';
import { loadOrCreateToken } from './token';
import { WorkspaceStore } from './workspace-store';

const config = loadConfig();
const shell = process.env.SHELL ?? '/bin/zsh';
const store = new WorkspaceStore(join(DATA_DIR, 'workspaces.json'));
const sessions = new SessionManager(SCROLLBACK_LIMIT);
const auth = { token: loadOrCreateToken(DATA_DIR), allowedOrigins: [`chrome-extension://${config.extensionId}`] };

let mcStatus: Map<string, McWorkspaceStatus> = readMcStatus(MC_STATE_DIR);
const statuses = (): Record<string, WorkspaceStatus> =>
  Object.fromEntries(store.list().map((ws) => [ws.id, mcStatus.get(ws.id)?.status ?? null]));

const REVIEW_POLL_MS = 5 * 60_000;
const execFileAsync = promisify(execFile);
// launchd's PATH lacks Homebrew, so gh runs through a login shell.
const gh = async (command: string) =>
  (await execFileAsync(shell, ['-l', '-c', command], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
const reviewSearches = [GH_REVIEW_REQUESTS, ...(config.watchRepos.length ? [ghWatchedPrs(config.watchRepos)] : [])];
// gh exits non-zero when GraphQL reports an error for any PR, but its stdout still holds the rest.
const ghMergeStates = async (query: string) => {
  try {
    return (await execFileAsync(shell, ['-l', '-c', 'gh api graphql -f query="$CW_QUERY"'], { env: { ...process.env, CW_QUERY: query }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch (error) {
    const { stdout } = error as { stdout?: string };
    if (stdout) return stdout;
    throw error;
  }
};
const reviews = new ReviewsPoller(() => Promise.all(reviewSearches.map(gh)), ghMergeStates);
const prompts = () => readPrompts(config.promptsFile);
const prDetails = async (url: string) =>
  (await execFileAsync(shell, ['-l', '-c', GH_PR_DETAILS], { env: { ...process.env, CW_PR_URL: url }, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout;

const control = new ControlHub({ store, sessions, defaultCwd: config.defaultCwd, statuses, reviews, prompts, prDetails, repoDirs: config.repoDirs, repos: () => listRepos(config.repoRoots), git: createGitService() });
reviews.onChange(() => control.broadcastState());
reviews.start(REVIEW_POLL_MS);
const stopWatching = watchMcStatus(MC_STATE_DIR, () => {
  const previous = mcStatus;
  mcStatus = readMcStatus(MC_STATE_DIR);
  control.broadcastState();
  for (const [id, { browserAt }] of mcStatus) {
    if (browserAt !== null && browserAt !== previous.get(id)?.browserAt) control.send({ type: 'browser', id, at: browserAt });
  }
});

const server = await startServer({
  host: HOST,
  port: PORT,
  auth,
  sessions,
  control,
  api: createApi({ auth, store, control, sessions, defaultCwd: config.defaultCwd, statuses, reviews, repoDirs: config.repoDirs }),
  onUnknownSession: (id) => {
    const workspace = store.get(id);
    if (!workspace) return undefined;
    const resumeId = mcStatus.get(id)?.claudeSessionId ?? null;
    const spec = launchSpec(workspace, { shell, resumeId, defaultModel: config.defaultModel });
    const session = sessions.create(spec);
    if (spec.env?.CW_PROMPT !== undefined) store.clearPrompt(id);
    return session;
  },
});

console.log(`chrome-workspaces helper on ${HOST}:${server.port} for extension ${config.extensionId}`);

function shutdown(): void {
  stopWatching();
  reviews.stop();
  sessions.killAll();
  void server.close().then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
