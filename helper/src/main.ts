import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR, HOST, PORT, SCROLLBACK_LIMIT } from './config';
import { startServer } from './server';
import { SessionManager } from './session';
import { loadOrCreateToken } from './token';

const { extensionId } = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8')) as { extensionId: string };
const shell = process.env.SHELL ?? '/bin/zsh';
const cwd = process.env.CW_SPIKE_CWD ?? homedir();

const sessions = new SessionManager(SCROLLBACK_LIMIT);
const server = await startServer({
  host: HOST,
  port: PORT,
  auth: { token: loadOrCreateToken(DATA_DIR), allowedOrigins: [`chrome-extension://${extensionId}`] },
  sessions,
  // Spike only: each window's panel gets its own login shell on first attach.
  // The next plan replaces this with sessions created from the workspace store.
  onUnknownSession: (id) => sessions.create({ id, command: shell, args: ['-l'], cwd }),
});

console.log(`chrome-workspaces helper on ${HOST}:${server.port} for extension ${extensionId}`);

function shutdown(): void {
  sessions.killAll();
  void server.close().then(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
