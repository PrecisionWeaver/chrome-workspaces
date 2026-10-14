import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { MONITOR_SESSION, SHELL_SESSION, type WorkspaceStatus } from '../../shared/protocol';
import { createAdmin, defaultIsManaged, defaultRunShell, defaultSpawnDetached } from './admin';
import { createApi } from './api';
import { DATA_DIR, HOST, LEGACY_SESSIONS_DIR, loadConfig, SESSIONS_DIR, PORT, SCROLLBACK_LIMIT } from './config';
import { ControlHub } from './control';
import { launchSpec, monitorSpec, shellSpec } from './launch';
import { importLegacySessions, readSessionStatus, lastTranscriptCwd, pruneSessions, watchSessionStatus, type WorkspaceSession } from './session-status';
import { writeHooksFile } from './hooks-config';
import { GH_BRANCH_PR, GH_PR_DETAILS, GH_PR_THREADS, PR_THREADS_QUERY } from './pr-details';
import { readPrompts } from './prompts';
import { createGitService } from './git';
import { HistoryStore } from './history';
import { listRepos } from './repos';
import { GH_REVIEW_REQUESTS, ghOwnPrs, ghWatchedPrs, ReviewsPoller } from './reviews';
import { startServer } from './server';
import { SessionManager } from './session';
import { loadOrCreateToken } from './token';
import { WorkspaceStore } from './workspace-store';
import { pruneUploads } from './uploads';

const config = loadConfig();
const shell = process.env.SHELL ?? '/bin/zsh';
pruneUploads(join(DATA_DIR, 'uploads'));
// The folder exists before the first hook runs, so its changes can be watched from the start.
mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
pruneSessions(SESSIONS_DIR);
importLegacySessions(LEGACY_SESSIONS_DIR, SESSIONS_DIR);
const hooksFile = writeHooksFile(DATA_DIR);
if (!hooksFile) console.warn('status hooks are off: hooks/session-state.ts is missing or Node is older than 22.18');
const store = new WorkspaceStore(join(DATA_DIR, 'workspaces.json'));
const sessions = new SessionManager(SCROLLBACK_LIMIT);
const auth = { token: loadOrCreateToken(DATA_DIR), allowedOrigins: [`chrome-extension://${config.extensionId}`] };

const readSessions = (): Map<string, WorkspaceSession> => readSessionStatus(SESSIONS_DIR, new Map(store.list().map((ws) => [ws.id, ws.cwd])));
let sessionState: Map<string, WorkspaceSession> = readSessions();
const statuses = (): Record<string, WorkspaceStatus> => Object.fromEntries(store.list().map((ws) => [ws.id, sessionState.get(ws.id)?.status ?? null]));

const REVIEW_POLL_MS = 5 * 60_000;
const execFileAsync = promisify(execFile);
// launchd's PATH lacks Homebrew, so gh runs through a login shell.
const gh = async (command: string) => (await execFileAsync(shell, ['-l', '-c', command], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
// Your own PRs are searched in every repo you have configured, watched or not.
const ownRepos = [...new Set([...config.watchRepos, ...Object.keys(config.repoDirs)])];
const reviewSearches = [
  GH_REVIEW_REQUESTS,
  ...(config.watchRepos.length ? [ghWatchedPrs(config.watchRepos)] : []),
  ...(ownRepos.length ? [ghOwnPrs(ownRepos)] : []),
];
// gh exits non-zero when GraphQL reports an error for any PR, but its stdout still holds the rest.
const ghMergeStates = async (query: string) => {
  try {
    return (
      await execFileAsync(shell, ['-l', '-c', 'gh api graphql -f query="$CW_QUERY"'], {
        env: { ...process.env, CW_QUERY: query },
        timeout: 30_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout;
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

const admin = createAdmin({
  sessions,
  store,
  config,
  paths: {
    dataDir: DATA_DIR,
    uploadDir: join(DATA_DIR, 'uploads'),
    logFile: join(DATA_DIR, 'helper.log'),
    configFile: join(DATA_DIR, 'config.json'),
    workspacesFile: join(DATA_DIR, 'workspaces.json'),
    hooksFile,
  },
  port: PORT,
  repoDir: resolve(import.meta.dirname, '..', '..'),
  commit: (() => {
    try {
      return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 3000 }).trim();
    } catch {
      return null;
    }
  })(),
  status: (id) => ({ status: sessionState.get(id)?.status ?? null, claudeSessionId: sessionState.get(id)?.claudeSessionId ?? null }),
  transcript: (id) => sessionState.get(id)?.transcriptPath ?? null,
  runShell: defaultRunShell(shell),
  spawnDetached: defaultSpawnDetached,
  isManaged: defaultIsManaged,
});

const history = new HistoryStore(join(DATA_DIR, 'history.json'));
// Workspaces an older version had archived are history now.
store.moveArchived((ws) => history.record(ws, ws.resume));
const branchPr = async (cwd: string) =>
  (
    await execFileAsync(shell, ['-l', '-c', GH_BRANCH_PR], { cwd, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }).catch(
      (error: { stderr?: string; message: string }) => {
        throw new Error(error.stderr?.trim() || error.message);
      },
    )
  ).stdout;

const prThreads = async ({ owner, repo, number }: { owner: string; repo: string; number: string }) =>
  (
    await execFileAsync(shell, ['-l', '-c', GH_PR_THREADS], {
      env: { ...process.env, CW_QUERY: PR_THREADS_QUERY, CW_OWNER: owner, CW_REPO: repo, CW_NUMBER: number },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }).catch((error: { stdout?: string; stderr?: string; message: string }) => {
      // gh exits non-zero when GraphQL reports an error but still prints the answer; the parser reads the message from it.
      if (error.stdout) return { stdout: error.stdout };
      throw new Error(error.stderr?.trim() || error.message);
    })
  ).stdout;

const control = new ControlHub({
  store,
  sessions,
  defaultCwd: config.defaultCwd,
  statuses,
  reviews,
  prompts,
  prDetails,
  prThreads,
  branchPr,
  repoDirs: config.repoDirs,
  repos: () => listRepos(config.repoRoots),
  git: createGitService(),
  admin,
  history,
  resumeId: (id) => sessionState.get(id)?.claudeSessionId ?? store.get(id)?.resume ?? null,
  workingDir: (id) => {
    const session = sessionState.get(id);
    return (session?.transcriptPath && lastTranscriptCwd(session.transcriptPath)) || session?.cwd || null;
  },
});
reviews.onChange(() => control.broadcastState());
reviews.start(REVIEW_POLL_MS);
const stopWatching = watchSessionStatus(SESSIONS_DIR, () => {
  const previous = sessionState;
  sessionState = readSessions();
  control.broadcastState();
  for (const [id, { browserAt }] of sessionState) {
    if (browserAt !== null && browserAt !== previous.get(id)?.browserAt) control.send({ type: 'browser', id, at: browserAt });
  }
});

const server = await startServer({
  host: HOST,
  port: PORT,
  auth,
  sessions,
  control,
  uploadDir: join(DATA_DIR, 'uploads'),
  api: createApi({ auth, store, control, sessions, defaultCwd: config.defaultCwd, statuses, reviews, repoDirs: config.repoDirs }),
  onUnknownSession: (id) => {
    if (id === MONITOR_SESSION) return sessions.create(monitorSpec(shell, homedir()));
    if (id === SHELL_SESSION) return sessions.create(shellSpec(shell, config.defaultCwd));
    const workspace = store.get(id);
    if (!workspace) return undefined;
    // A restored workspace has no session of its own yet, so it resumes the one it had.
    const resumeId = sessionState.get(id)?.claudeSessionId ?? workspace.resume ?? null;
    const spec = launchSpec(workspace, { shell, resumeId, defaultModel: config.defaultModel, command: config.claudeCommand, hooksFile });
    const session = sessions.create(spec);
    if (spec.env?.CW_PROMPT !== undefined) store.clearPrompt(id);
    return session;
  },
});

console.log(`chrome-workspaces helper on ${HOST}:${server.port} for extension ${config.extensionId}`);
for (const problem of config.problems) console.warn(`config: ${problem}`);

function shutdown(): void {
  stopWatching();
  reviews.stop();
  sessions.killAll();
  void server.close().then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
