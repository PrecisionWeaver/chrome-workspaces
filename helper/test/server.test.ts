import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL, TOKEN_PROTOCOL_PREFIX, type ServerMessage } from '../../shared/protocol';
import { startServer, type RunningServer, type ServerOptions } from '../src/server';
import { SessionManager } from '../src/session';
import { waitFor } from './wait-for';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const TOKEN = 'a'.repeat(64);

let sessions: SessionManager;
let server: RunningServer;

async function start(onUnknownSession?: ServerOptions['onUnknownSession']): Promise<void> {
  server = await startServer({
    host: '127.0.0.1',
    port: 0,
    auth: { token: TOKEN, allowedOrigins: [ORIGIN] },
    sessions,
    onUnknownSession,
  });
}

function connect(path: string, origin: string | null = ORIGIN, token = TOKEN): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${server.port}${path}`, [PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`], origin ? { origin } : {});
}

function rejectionStatus(ws: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    ws.on('open', () => reject(new Error('connection was accepted')));
    ws.on('error', () => {});
  });
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on('close', (code) => resolve(code)));
}

beforeEach(() => {
  sessions = new SessionManager(10_000);
  sessions.create({ id: 'cat', command: '/bin/cat', args: [], cwd: tmpdir() });
});

afterEach(async () => {
  await server.close();
  sessions.killAll();
});

describe('helper server', () => {
  it('rejects a foreign origin with 401', async () => {
    await start();
    expect(await rejectionStatus(connect('/attach?session=cat', 'https://evil.example'))).toBe(401);
  });

  it('rejects a missing origin with 401', async () => {
    await start();
    expect(await rejectionStatus(connect('/attach?session=cat', null))).toBe(401);
  });

  it('rejects a wrong token with 401', async () => {
    await start();
    expect(await rejectionStatus(connect('/attach?session=cat', ORIGIN, 'b'.repeat(64)))).toBe(401);
  });

  it('closes with 4404 for an unknown session', async () => {
    await start();
    expect(await closeCode(connect('/attach?session=nope'))).toBe(4404);
  });

  it('closes with 4400 for a malformed session id', async () => {
    await start();
    expect(await closeCode(connect('/attach?session=../../etc'))).toBe(4400);
  });

  it('relays input to the session and output back', async () => {
    await start();
    const ws = connect('/attach?session=cat');
    let output = '';
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      if (msg.type === 'output') output += msg.data;
    });
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'input', data: 'ping\r' }));
    await waitFor(() => output.includes('ping'));
    ws.close();
  });

  it('replaces an exited session with a fresh one from onUnknownSession', async () => {
    await start((id) => sessions.create({ id, command: '/bin/cat', args: [], cwd: tmpdir() }));
    const old = sessions.create({ id: 'done', command: '/bin/sh', args: ['-c', 'exit 0'], cwd: tmpdir() });
    await waitFor(() => old.exited);

    const ws = connect('/attach?session=done');
    await new Promise((resolve) => ws.on('open', resolve));
    const fresh = sessions.get('done');
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(old);
    expect(fresh?.exited).toBe(false);
    ws.close();
  });

  it('asks onUnknownSession for sessions it does not have', async () => {
    await start((id) => sessions.create({ id, command: '/bin/cat', args: [], cwd: tmpdir() }));
    const ws = connect('/attach?session=fresh');
    await new Promise((resolve) => ws.on('open', resolve));
    expect(sessions.get('fresh')).toBeDefined();
    ws.close();
  });

  it('ends the monitor when the last panel leaves, but keeps any other session running', async () => {
    await start((id) => sessions.create({ id, command: '/bin/cat', args: [], cwd: tmpdir() }));
    const open = async (id: string) => {
      const ws = connect(`/attach?session=${id}`);
      await new Promise((resolve) => ws.on('open', resolve));
      return ws;
    };
    const first = await open('monitor');
    const second = await open('monitor');
    const workspace = await open('cat');
    const monitor = sessions.get('monitor')!;

    first.close();
    await waitFor(() => monitor.attached === 1);
    expect(sessions.get('monitor')).toBe(monitor);

    second.close();
    await waitFor(() => sessions.get('monitor') === undefined);
    await waitFor(() => monitor.exited);

    workspace.close();
    await waitFor(() => sessions.get('cat')?.attached === 0);
    expect(sessions.get('cat')).toBeDefined();
  });

  it('keeps the shell running when the panel leaves, and reattaches to it with what it printed', async () => {
    await start((id) => sessions.create({ id, command: '/bin/cat', args: [], cwd: tmpdir() }));
    const first = connect('/attach?session=shell');
    await new Promise((resolve) => first.on('open', resolve));
    const shell = sessions.get('shell')!;
    first.send(JSON.stringify({ type: 'input', data: 'still-here\r' }));
    await waitFor(() => shell.attached === 1);
    first.close();
    await waitFor(() => shell.attached === 0);
    expect(sessions.get('shell')).toBe(shell);
    expect(shell.exited).toBe(false);

    let replayed = '';
    const second = connect('/attach?session=shell');
    second.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as ServerMessage;
      if (msg.type === 'output' && msg.replay) replayed += msg.data;
    });
    await new Promise((resolve) => second.on('open', resolve));
    await waitFor(() => replayed.includes('still-here'));
    expect(sessions.get('shell')).toBe(shell);
    second.close();
  });
});
