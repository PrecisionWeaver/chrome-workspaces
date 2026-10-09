import { existsSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { MAX_UPLOAD_BYTES, PROTOCOL, TOKEN_PROTOCOL_PREFIX, type ServerMessage } from '../../shared/protocol';
import { startServer } from '../src/server';
import { SessionManager } from '../src/session';
import { pruneUploads, safeName, saveUpload } from '../src/uploads';
import { waitFor } from './wait-for';

const b64 = (text: string) => Buffer.from(text).toString('base64');

describe('safeName', () => {
  it('keeps the base name, plain characters and a bounded length', () => {
    expect(safeName('Screen Shot 2026 at 9.14 AM.png')).toBe('Screen_Shot_2026_at_9.14_AM.png');
    expect(safeName('../../etc/passwd')).toBe('passwd');
    expect(safeName('C:\\Users\\me\\a b.txt')).toBe('a_b.txt');
    expect(safeName('$(touch x);`id`.png')).toBe('_touch_x_id_.png');
    expect(safeName('...')).toBe('file');
    expect(safeName(`${'x'.repeat(200)}.png`).length).toBeLessThanOrEqual(80);
    expect(safeName(`${'x'.repeat(200)}.png`).endsWith('.png')).toBe(true);
  });
});

describe('saveUpload', () => {
  it('writes the bytes under the session, with a unique name, readable only by the user', () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-up-'));
    const a = saveUpload(root, 'ws-1', 'shot.png', b64('hello'));
    const b = saveUpload(root, 'ws-1', 'shot.png', b64('again'));
    expect(a).not.toBe(b);
    expect(a.startsWith(join(root, 'ws-1'))).toBe(true);
    expect(basename(a)).toMatch(/^[0-9a-f]{6}-shot\.png$/);
    expect(readFileSync(a, 'utf8')).toBe('hello');
    expect(statSync(a).mode & 0o777).toBe(0o600);
  });

  it('refuses a session id that could leave the folder, and a file over the limit', () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-up-'));
    expect(() => saveUpload(root, '../x', 'a.txt', b64('x'))).toThrow('session');
    expect(() => saveUpload(root, 'ws-1', 'a.bin', Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64'))).toThrow('too large');
  });
});

describe('pruneUploads', () => {
  it('removes files older than a week and empty session folders, keeping recent ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'cw-up-'));
    const old = saveUpload(root, 'ws-old', 'a.txt', b64('x'));
    const fresh = saveUpload(root, 'ws-new', 'b.txt', b64('y'));
    const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);
    pruneUploads(root);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(root, 'ws-old'))).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('does nothing when there is no uploads folder', () => {
    expect(() => pruneUploads(join(tmpdir(), 'cw-no-such-uploads'))).not.toThrow();
  });
});

describe('file messages on a terminal socket', () => {
  it('saves a dropped file and answers with its path, or with why it could not', async () => {
    const uploadDir = mkdtempSync(join(tmpdir(), 'cw-up-'));
    const sessions = new SessionManager(10_000);
    sessions.create({ id: 'cat', command: '/bin/cat', args: [], cwd: tmpdir() });
    const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
    const TOKEN = 'a'.repeat(64);
    const server = await startServer({ host: '127.0.0.1', port: 0, auth: { token: TOKEN, allowedOrigins: [ORIGIN] }, sessions, uploadDir });
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/attach?session=cat`, [PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${TOKEN}`], { origin: ORIGIN });
    const replies: ServerMessage[] = [];
    ws.on('message', (raw) => replies.push(JSON.parse(raw.toString()) as ServerMessage));
    await new Promise((resolve) => ws.on('open', resolve));

    ws.send(JSON.stringify({ type: 'file', name: 'my shot.png', data: b64('png-bytes') }));
    ws.send(JSON.stringify({ type: 'file', name: 'big.bin', data: Buffer.alloc(MAX_UPLOAD_BYTES + 1).toString('base64') }));
    await waitFor(() => replies.filter((m) => m.type === 'uploaded').length === 2);

    const [saved, refused] = replies.filter((m) => m.type === 'uploaded');
    expect(saved).toMatchObject({ name: 'my shot.png', error: null, path: expect.stringContaining(join(uploadDir, 'cat')) });
    if (saved.type === 'uploaded' && saved.path) expect(readFileSync(saved.path, 'utf8')).toBe('png-bytes');
    expect(refused).toMatchObject({ name: 'big.bin', path: null, error: 'file too large' });
    ws.close();
    await server.close();
    sessions.killAll();
  });
});
