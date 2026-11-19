import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { PLAN_USAGE_FILE } from '../../shared/usage/plan-usage';
import type { WaitingOn, WorkspaceStatus } from '../../shared/protocol/workspace';
import { SAMPLE_INTERVAL_MS } from './store/resource-history';
import { activityFile, readActivity } from './claude/activity';
import { createAdmin } from './admin/admin';
import { defaultIsManaged, defaultRunShell, defaultSpawnDetached } from './admin/shell';
import { createApi } from './transport/api';
import { readConfigEdit, saveConfigEdit } from './platform/config-edit';
import { DATA_DIR, HOST, loadConfig, SESSIONS_DIR, PORT, SCROLLBACK_LIMIT } from './platform/config';
import { ControlHub } from './control/hub';
import {
  listWorkspaceSessions,
  readSessionStatus,
  lastTranscriptCwd,
  pruneSessions,
  sameStatuses,
  watchSessionStatus,
  type WorkspaceSession,
} from './claude/session-status';
import { writeHooksFile } from './claude/hooks-config';
import { readPlanUsage } from './claude/plan-usage';
import { GH_BRANCH_PR, GH_PR_CREATE, GH_PR_DETAILS, GH_PR_THREADS, PR_THREADS_QUERY } from './git/pr-details';
import { readAllPrompts } from './store/prompts';
import { readTemplatesFile } from './store/templates-file';
import { createGitService } from './git/git';
import { createGh, newPullRequestUrl } from './git/gh';
import { startSession } from './pty/start-session';
import { HistoryStore } from './store/history';
import { listRepos } from './git/repos';
import { GH_REVIEW_REQUESTS, ghOwnPrs, ghReviewedPrs, ghWatchedPrs } from './git/review-queries';
import { ReviewsPoller } from './git/reviews';
import { startServer } from './transport/server';
import { SessionManager } from './pty/session';
import { ScrollbackStore } from './pty/scrollback-store';
import { loadOrCreateToken } from './platform/token';
import { WorkspaceStore } from './store/workspace-store';
import { stampConsole } from './platform/log';
import { rotateLog } from './platform/log-rotation';
import { pruneUploads } from './transport/uploads';
import { errorMessage } from '../../shared/protocol/errors';

stampConsole();
// A crash's stack trace follows unstamped, so this line says when it happened.
process.on('uncaughtExceptionMonitor', (error) => console.error(`crashed: ${errorMessage(error)}`));
// A promise nobody caught would otherwise end the helper, and every terminal with it, over one failed request.
process.on('unhandledRejection', (reason) => console.error(`unhandled: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`));

const config = loadConfig();
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const shell = process.env.SHELL ?? '/bin/zsh';
pruneUploads(join(DATA_DIR, 'uploads'));
const LOG_FILE = join(DATA_DIR, 'helper.log');
rotateLog(LOG_FILE);
// The agent can run for weeks, so the log is checked as well as at start.
setInterval(() => rotateLog(LOG_FILE), 60 * 60_000).unref();
// The folder exists before the first hook runs, so its changes can be watched from the start.
mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o700 });
pruneSessions(SESSIONS_DIR);
// Pruned daily too, for the same reason as the log; a longer list also slows every status read.
setInterval(
  () => {
    pruneSessions(SESSIONS_DIR);
    pruneUploads(join(DATA_DIR, 'uploads'));
  },
  24 * 60 * 60_000,
).unref();
const hooksFile = writeHooksFile(DATA_DIR);
if (!hooksFile) console.warn('status hooks are off: hooks/session-state.ts is missing or Node is older than 22.18');
const store = new WorkspaceStore(join(DATA_DIR, 'workspaces.json'));
// What each terminal showed when the helper last stopped, so a restart does not empty them.
const savedScrollback = new ScrollbackStore(join(DATA_DIR, 'scrollback'));
savedScrollback.prune();
const sessions = new SessionManager(SCROLLBACK_LIMIT, savedScrollback);
const auth = { token: loadOrCreateToken(DATA_DIR), allowedOrigins: [`chrome-extension://${config.extensionId}`] };

const readSessions = (): Map<string, WorkspaceSession> => readSessionStatus(SESSIONS_DIR, new Map(store.list().map((ws) => [ws.id, ws.cwd])));
let sessionState: Map<string, WorkspaceSession> = readSessions();
const statuses = (): Record<string, WorkspaceStatus> => Object.fromEntries(store.list().map((ws) => [ws.id, sessionState.get(ws.id)?.status ?? null]));
const waiting = (): Record<string, WaitingOn> =>
  Object.fromEntries(store.list().flatMap((ws) => (sessionState.get(ws.id)?.waiting ? [[ws.id, sessionState.get(ws.id)!.waiting!]] : [])));

const REVIEW_POLL_MS = 5 * 60_000;
const gh = createGh(shell);
// Your own PRs are searched in every repo you have configured, watched or not.
const ownRepos = [...new Set([...config.watchRepos, ...Object.keys(config.repoDirs)])];
const reviewSearches = [
  GH_REVIEW_REQUESTS,
  ...(config.watchRepos.length ? [ghWatchedPrs(config.watchRepos)] : []),
  ...(ownRepos.length ? [ghOwnPrs(ownRepos)] : []),
];
// gh exits non-zero when GraphQL reports an error for any PR, but its stdout still holds the rest.
const ghMergeStates = (query: string) => gh('gh api graphql -f query="$CW_QUERY"', { env: { CW_QUERY: query }, keepStdout: true });
const reviews = new ReviewsPoller(() => Promise.all(reviewSearches.map((search) => gh(search))), ghMergeStates, undefined, {
  // PRs you reviewed no longer match a review request, so they are looked for separately, in every repo.
  fetchReviewed: async () => [await gh(ghReviewedPrs)],
});
const prompts = () => readAllPrompts([config.promptsFile, ...config.promptsFiles]);
const templates = () => readTemplatesFile(config.templatesFile);
const prDetails = (url: string) => gh(GH_PR_DETAILS, { env: { CW_PR_URL: url } });

/** Where a workspace's claude last was: the worktree it moved into, else where it started. */
function workingDir(id: string): string | null {
  const session = sessionState.get(id);
  return (session?.transcriptPath && lastTranscriptCwd(session.transcriptPath)) || session?.cwd || null;
}

const admin = createAdmin({
  planUsage: () => readPlanUsage(join(DATA_DIR, PLAN_USAGE_FILE)),
  sessions,
  store,
  config,
  paths: {
    dataDir: DATA_DIR,
    uploadDir: join(DATA_DIR, 'uploads'),
    logFile: LOG_FILE,
    configFile: CONFIG_FILE,
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
  // An archived workspace's transcript, for counting into the usage ledger if it was never counted while live.
  archived: () =>
    history.list().flatMap((entry) => {
      const transcript = entry.workspaceId ? sessionState.get(entry.workspaceId)?.transcriptPath : null;
      return entry.workspaceId && transcript ? [{ id: entry.workspaceId, name: entry.name, transcript }] : [];
    }),
  runShell: defaultRunShell(shell),
  spawnDetached: defaultSpawnDetached,
  isManaged: defaultIsManaged,
});
// Memory and CPU trends need readings between snapshots, which are only taken while Settings is open.
// A failing sample also stops the usage ledger from being kept current, so it is logged, not swallowed.
setInterval(() => void admin.sample().catch((error) => console.error(`sample failed: ${errorMessage(error)}`)), SAMPLE_INTERVAL_MS).unref();

const history = new HistoryStore(join(DATA_DIR, 'history.json'));
// Workspaces an older version had archived are history now.
store.moveArchived((ws) => history.record(ws, ws.resume));
const branchPr = (cwd: string) => gh(GH_BRANCH_PR, { cwd, stderrAs: 'message' });

const createPr = async (cwd: string) =>
  newPullRequestUrl(await gh(GH_PR_CREATE, { cwd, timeoutMs: 60_000, maxBufferBytes: 1024 * 1024, stderrAs: 'last-line' }));

// gh exits non-zero when GraphQL reports an error but still prints the answer; the parser reads the message from it.
const prThreads = ({ owner, repo, number }: { owner: string; repo: string; number: string }) =>
  gh(GH_PR_THREADS, { env: { CW_QUERY: PR_THREADS_QUERY, CW_OWNER: owner, CW_REPO: repo, CW_NUMBER: number }, keepStdout: true, stderrAs: 'message' });

const git = createGitService();

// An earlier conversation picked for a workspace, used by its next start alone.
const resumeOverride = new Map<string, string>();
const control = new ControlHub({
  store,
  sessions,
  // A getter, so a save from Settings reaches the next workspace.
  get defaultCwd() {
    return config.defaultCwd;
  },
  statuses,
  waiting,
  reviews,
  prompts,
  templates,
  prDetails,
  prThreads,
  branchPr,
  createPr,
  repoDirs: config.repoDirs,
  repos: () => listRepos(config.repoRoots),
  git,
  admin,
  configEdit: {
    read: () => readConfigEdit(CONFIG_FILE, config),
    save: (values, promptsText) => saveConfigEdit(CONFIG_FILE, config, values, promptsText),
  },
  history,
  resumeId: (id) => sessionState.get(id)?.claudeSessionId ?? store.get(id)?.resume ?? null,
  pastSessions: (id) => listWorkspaceSessions(SESSIONS_DIR, id, store.get(id)?.cwd ?? null),
  resumeWith: (id, sessionId) => {
    resumeOverride.set(id, sessionId);
    sessions.remove(id);
  },
  workingDir,
  activity: (id) => {
    const session = sessionState.get(id);
    return session ? readActivity(activityFile(SESSIONS_DIR, session.claudeSessionId)) : null;
  },
});
reviews.onChange(() => control.broadcastState());
reviews.start(REVIEW_POLL_MS);
const stopWatching = watchSessionStatus(SESSIONS_DIR, () => {
  const previous = sessionState;
  sessionState = readSessions();
  // Every tool call touches the folder, but `state` only carries each status and what it waits on.
  if (!sameStatuses(previous, sessionState)) control.broadcastState();
  control.pushActivity();
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
  api: createApi({
    auth,
    store,
    control,
    sessions,
    get defaultCwd() {
      return config.defaultCwd;
    },
    statuses,
    waiting,
    history,
    reviews,
    repoDirs: config.repoDirs,
    git,
  }),
  onUnknownSession: (id) =>
    startSession(id, {
      shell,
      defaultCwd: config.defaultCwd,
      home: homedir(),
      defaultModel: config.defaultModel,
      claudeCommand: config.claudeCommand,
      claudeArgs: config.claudeArgs,
      hooksFile,
      store,
      sessions,
      resumeOverride,
      claudeSessionId: (workspaceId) => sessionState.get(workspaceId)?.claudeSessionId ?? null,
      workingDir,
      log: console.log,
    }),
});

console.log(`chrome-workspaces helper on ${HOST}:${server.port} for extension ${config.extensionId}`);
for (const problem of config.problems) console.warn(`config: ${problem}`);

function shutdown(signal: NodeJS.Signals): void {
  const running = sessions.list().filter((session) => !session.exited).length;
  console.log(`stopping on ${signal}, ending ${running} terminal${running === 1 ? '' : 's'}`);
  stopWatching();
  reviews.stop();
  try {
    sessions.saveAll();
  } catch (error) {
    console.error(`could not save scrollback: ${errorMessage(error)}`);
  }
  sessions.killAll();
  // A request still in flight (a `gh pr create`, say) must not keep the helper from stopping: launchd would only kill it later.
  setTimeout(() => process.exit(0), 5000).unref();
  void server.close().then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
