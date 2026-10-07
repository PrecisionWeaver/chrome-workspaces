import { join } from 'node:path';
import type { WorkspaceStatus } from '../../shared/protocol';
import { createApi } from './api';
import { DATA_DIR, HOST, loadConfig, MC_STATE_DIR, PORT, SCROLLBACK_LIMIT } from './config';
import { ControlHub } from './control';
import { launchSpec } from './launch';
import { readMcStatus, watchMcStatus, type McWorkspaceStatus } from './mc-status';
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

const control = new ControlHub({ store, defaultCwd: config.defaultCwd, statuses });
const stopWatching = watchMcStatus(MC_STATE_DIR, () => {
  mcStatus = readMcStatus(MC_STATE_DIR);
  control.broadcastState();
});

const server = await startServer({
  host: HOST,
  port: PORT,
  auth,
  sessions,
  control,
  api: createApi({ auth, store, control, sessions, defaultCwd: config.defaultCwd, statuses }),
  onUnknownSession: (id) => {
    const workspace = store.get(id);
    if (!workspace) return undefined;
    const resumeId = mcStatus.get(id)?.claudeSessionId ?? null;
    return sessions.create(launchSpec(workspace, { shell, resumeId }));
  },
});

console.log(`chrome-workspaces helper on ${HOST}:${server.port} for extension ${config.extensionId}`);

function shutdown(): void {
  stopWatching();
  sessions.killAll();
  void server.close().then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
