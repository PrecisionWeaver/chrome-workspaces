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

  it('asks onUnknownSession for sessions it does not have', async () => {
    await start((id) => sessions.create({ id, command: '/bin/cat', args: [], cwd: tmpdir() }));
    const ws = connect('/attach?session=fresh');
    await new Promise((resolve) => ws.on('open', resolve));
    expect(sessions.get('fresh')).toBeDefined();
    ws.close();
  });
});
