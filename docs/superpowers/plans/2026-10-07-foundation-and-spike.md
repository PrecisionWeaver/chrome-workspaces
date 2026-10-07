# Chrome Workspaces — Foundation + Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the helper's core (PTY sessions, scrollback replay, authenticated WebSocket, native-messaging token bridge) plus a minimal side-panel extension, then use it to answer the spec's three open risks before the full build is planned.

**Architecture:** A Node helper on `127.0.0.1:4178` owns one PTY per session and relays it over a WebSocket that only accepts our extension's `Origin` plus a token carried in the WebSocket subprotocol header. The MV3 extension gets that token from a Chrome native-messaging host, renders xterm.js in the side panel, and attaches each Chrome window to its own session (`win-<windowId>`). Spike-only behavior (auto-creating a shell per window, cycling through all Chrome windows) is marked as such and is replaced by the workspace store in the next plan.

**Tech Stack:** Node 22, TypeScript (run via `tsx`), `node-pty`, `ws`, `@xterm/xterm` + `@xterm/addon-fit`, `esbuild`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-10-07-chrome-workspaces-design.md`

**Scope:** This plan stops at the spike results. Workspace store, pairing/re-pairing, workspace list UI, `devspace`, Mission Control, and launchd are the next plan, written once `docs/spike-results.md` exists.

---

## File structure

| File | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore` | Project scaffolding |
| `shared/protocol.ts` | Constants and message types shared by helper and extension (no Node imports — it is bundled into the extension) |
| `helper/src/config.ts` | Helper-only settings: host, port, data dir, scrollback limit |
| `helper/src/scrollback.ts` | Bounded ring buffer of PTY output for replay on attach |
| `helper/src/token.ts` | Create/load the 0600 token file |
| `helper/src/auth.ts` | Pull the token from the subprotocol header; Origin + token check |
| `helper/src/session.ts` | `Session` (one PTY + listeners + scrollback) and `SessionManager` |
| `helper/src/server.ts` | HTTP server, WebSocket upgrade auth, `/attach` relay |
| `helper/src/native-host.ts` | Chrome native-messaging host: replies with `{ token, port }` |
| `helper/src/main.ts` | Helper entry point (spike wiring) |
| `helper/test/*.test.ts` | Tests for the above |
| `scripts/extension-id.ts` | Compute a Chrome extension ID from the manifest `key` |
| `scripts/gen-key.ts` | One-time: write a public key into `extension/manifest.json` so the ID is stable |
| `scripts/setup.ts` | Write `~/.chrome-workspaces/config.json`, the native-host wrapper, and Chrome's native-host manifest |
| `scripts/build-extension.ts` | Bundle the extension into `extension/dist` |
| `extension/manifest.json`, `extension/panel.html`, `extension/panel.css` | Extension static files |
| `extension/src/background.ts` | Service worker: panel behavior, shortcut handling, spike window cycling |
| `extension/src/panel.ts` | Side panel: status bar + xterm.js attached to the helper |
| `docs/spike-results.md` | Measured answers to the three open risks |

---

### Task 1: Scaffold the project

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `shared/protocol.ts`, `helper/src/config.ts`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "chrome-workspaces",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "helper": "tsx helper/src/main.ts",
    "gen-key": "tsx scripts/gen-key.ts",
    "setup": "tsx scripts/setup.ts",
    "build:extension": "tsx scripts/build-extension.ts"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run:
```bash
npm install node-pty@1.1.0 ws@8.22.0 @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0
npm install -D typescript tsx@4.23.15 esbuild@0.28.2 vitest@5.0.3 @types/node@22 @types/ws @types/chrome
```
Expected: both complete without errors.

If `node-pty` later fails with `posix_spawnp failed`, its prebuilt helper lost its execute bit; fix with:
```bash
chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM"],
    "types": ["node", "chrome"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["shared", "helper", "extension/src", "scripts", "vitest.config.ts"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

`node-pty` is a native module; forked workers avoid loading it inside worker threads.

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['helper/test/**/*.test.ts', 'scripts/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 10_000,
  },
});
```

- [ ] **Step 5: Write `.gitignore`**

```
node_modules/
extension/dist/
```

- [ ] **Step 6: Write `shared/protocol.ts`**

```ts
// Shared by the helper and the extension bundle — keep this free of Node imports.

export const PROTOCOL = 'cw.v1';
export const TOKEN_PROTOCOL_PREFIX = 'token.';
export const NATIVE_HOST_NAME = 'com.chrome_workspaces.helper';

export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type ServerMessage =
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number };

export type NativeHostReply =
  | { ok: true; token: string; port: number }
  | { ok: false; error: string };
```

- [ ] **Step 7: Write `helper/src/config.ts`**

```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOST = '127.0.0.1';
export const PORT = 4178;
export const DATA_DIR = process.env.CW_DATA_DIR ?? join(homedir(), '.chrome-workspaces');
export const SCROLLBACK_LIMIT = 2_000_000;
```

- [ ] **Step 8: Verify typecheck passes**

Run: `npm run typecheck`
Expected: exits 0 with no output.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore shared helper/src/config.ts
git commit -m "chore: scaffold helper and extension project

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Scrollback ring buffer

**Files:**
- Create: `helper/src/scrollback.ts`
- Test: `helper/test/scrollback.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { Scrollback } from '../src/scrollback';

describe('Scrollback', () => {
  it('returns everything pushed while under the limit', () => {
    const buffer = new Scrollback(100);
    buffer.push('hello ');
    buffer.push('world');
    expect(buffer.snapshot()).toBe('hello world');
  });

  it('drops whole chunks from the front once over the limit', () => {
    const buffer = new Scrollback(6);
    buffer.push('abc');
    buffer.push('def');
    buffer.push('ghi');
    expect(buffer.snapshot()).toBe('defghi');
  });

  it('trims a partial chunk so exactly the newest `limit` characters remain', () => {
    const buffer = new Scrollback(4);
    buffer.push('abcdef');
    expect(buffer.snapshot()).toBe('cdef');
  });

  it('is empty before anything is pushed', () => {
    expect(new Scrollback(10).snapshot()).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run helper/test/scrollback.test.ts`
Expected: FAIL — cannot resolve `../src/scrollback`.

- [ ] **Step 3: Write the implementation**

Trimming can cut through an escape sequence; xterm.js tolerates a garbled first line on replay, which is acceptable.

```ts
export class Scrollback {
  private chunks: string[] = [];
  private length = 0;

  constructor(private readonly limit: number) {}

  push(data: string): void {
    this.chunks.push(data);
    this.length += data.length;

    while (this.length > this.limit) {
      const head = this.chunks[0];
      const excess = this.length - this.limit;
      if (head.length <= excess) {
        this.chunks.shift();
        this.length -= head.length;
      } else {
        this.chunks[0] = head.slice(excess);
        this.length -= excess;
      }
    }
  }

  snapshot(): string {
    return this.chunks.join('');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run helper/test/scrollback.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add helper/src/scrollback.ts helper/test/scrollback.test.ts
git commit -m "feat(helper): bounded scrollback buffer for replay

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Token file

**Files:**
- Create: `helper/src/token.ts`
- Test: `helper/test/token.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateToken } from '../src/token';

describe('loadOrCreateToken', () => {
  it('creates a 64-hex-character token readable only by the owner', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cw-token-')), 'data');
    const token = loadOrCreateToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
  });

  it('returns the same token on later calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-token-'));
    expect(loadOrCreateToken(dir)).toBe(loadOrCreateToken(dir));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run helper/test/token.test.ts`
Expected: FAIL — cannot resolve `../src/token`.

- [ ] **Step 3: Write the implementation**

```ts
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadOrCreateToken(dir: string): string {
  const file = join(dir, 'token');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run helper/test/token.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add helper/src/token.ts helper/test/token.test.ts
git commit -m "feat(helper): owner-only token file

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Connection auth

Browsers can't set headers on a WebSocket, so the token rides in the subprotocol list (`['cw.v1', 'token.<hex>']`), which keeps it out of the URL.

**Files:**
- Create: `helper/src/auth.ts`
- Test: `helper/test/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { isAuthorized, tokenFromProtocols } from '../src/auth';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const policy = { token: 'a'.repeat(64), allowedOrigins: [ORIGIN] };

describe('tokenFromProtocols', () => {
  it('extracts the token entry from the subprotocol header', () => {
    expect(tokenFromProtocols(`cw.v1, token.${'a'.repeat(64)}`)).toBe('a'.repeat(64));
  });

  it('returns null when no token entry is present', () => {
    expect(tokenFromProtocols('cw.v1')).toBeNull();
    expect(tokenFromProtocols(undefined)).toBeNull();
  });
});

describe('isAuthorized', () => {
  it('accepts the extension origin with the right token', () => {
    expect(isAuthorized(policy, ORIGIN, 'a'.repeat(64))).toBe(true);
  });

  it('rejects any other origin', () => {
    expect(isAuthorized(policy, 'https://evil.example', 'a'.repeat(64))).toBe(false);
  });

  it('rejects a missing origin', () => {
    expect(isAuthorized(policy, undefined, 'a'.repeat(64))).toBe(false);
  });

  it('rejects a wrong or missing token', () => {
    expect(isAuthorized(policy, ORIGIN, 'b'.repeat(64))).toBe(false);
    expect(isAuthorized(policy, ORIGIN, 'a')).toBe(false);
    expect(isAuthorized(policy, ORIGIN, null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run helper/test/auth.test.ts`
Expected: FAIL — cannot resolve `../src/auth`.

- [ ] **Step 3: Write the implementation**

```ts
import { timingSafeEqual } from 'node:crypto';
import { TOKEN_PROTOCOL_PREFIX } from '../../shared/protocol';

export interface AuthPolicy {
  token: string;
  allowedOrigins: readonly string[];
}

export function tokenFromProtocols(header: string | undefined): string | null {
  if (!header) return null;
  for (const entry of header.split(',')) {
    const value = entry.trim();
    if (value.startsWith(TOKEN_PROTOCOL_PREFIX)) return value.slice(TOKEN_PROTOCOL_PREFIX.length);
  }
  return null;
}

export function isAuthorized(policy: AuthPolicy, origin: string | undefined, token: string | null): boolean {
  if (!origin || !policy.allowedOrigins.includes(origin)) return false;
  if (!token) return false;
  const given = Buffer.from(token);
  const expected = Buffer.from(policy.token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run helper/test/auth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add helper/src/auth.ts helper/test/auth.test.ts
git commit -m "feat(helper): origin and token check for connections

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: PTY sessions

**Files:**
- Create: `helper/src/session.ts`, `helper/test/wait-for.ts`
- Test: `helper/test/session.test.ts`

- [ ] **Step 1: Write the polling helper used by async tests**

`helper/test/wait-for.ts`:
```ts
export function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`waitFor timed out after ${timeoutMs}ms`));
      }
    }, 10);
  });
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../src/session';
import { waitFor } from './wait-for';

let sessions: SessionManager;

afterEach(() => sessions.killAll());

describe('Session', () => {
  it('replays output and the exit code to a client that attaches after exit', async () => {
    sessions = new SessionManager(10_000);
    const session = sessions.create({ id: 'echo', command: '/bin/sh', args: ['-c', 'printf hello'], cwd: tmpdir() });
    await waitFor(() => session.exited);

    let output = '';
    let exitCode: number | null = null;
    session.attach((data) => (output += data), (code) => (exitCode = code));

    expect(output).toContain('hello');
    expect(exitCode).toBe(0);
  });

  it('relays input to the process and its output back to attached clients', async () => {
    sessions = new SessionManager(10_000);
    const session = sessions.create({ id: 'cat', command: '/bin/cat', args: [], cwd: tmpdir() });

    let output = '';
    session.attach((data) => (output += data), () => {});
    session.write('ping\r');

    await waitFor(() => output.includes('ping'));
  });

  it('stops delivering output after detach', async () => {
    sessions = new SessionManager(10_000);
    const session = sessions.create({ id: 'cat', command: '/bin/cat', args: [], cwd: tmpdir() });

    let output = '';
    const detach = session.attach((data) => (output += data), () => {});
    detach();
    session.write('after\r');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(output).not.toContain('after');
  });

  it('refuses a duplicate session id', () => {
    sessions = new SessionManager(10_000);
    sessions.create({ id: 'dup', command: '/bin/cat', args: [], cwd: tmpdir() });
    expect(() => sessions.create({ id: 'dup', command: '/bin/cat', args: [], cwd: tmpdir() })).toThrow(/already exists/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run helper/test/session.test.ts`
Expected: FAIL — cannot resolve `../src/session`.

- [ ] **Step 4: Write the implementation**

```ts
import { spawn, type IPty } from 'node-pty';
import { Scrollback } from './scrollback';

export interface SessionSpec {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
}

type DataListener = (data: string) => void;
type ExitListener = (code: number) => void;

export class Session {
  readonly id: string;
  private readonly pty: IPty;
  private readonly scrollback: Scrollback;
  private readonly dataListeners = new Set<DataListener>();
  private readonly exitListeners = new Set<ExitListener>();
  private exitCode: number | null = null;

  constructor(spec: SessionSpec, scrollbackLimit: number) {
    this.id = spec.id;
    this.scrollback = new Scrollback(scrollbackLimit);
    this.pty = spawn(spec.command, spec.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
    });
    this.pty.onData((data) => {
      this.scrollback.push(data);
      for (const listener of this.dataListeners) listener(data);
    });
    this.pty.onExit(({ exitCode }) => {
      this.exitCode = exitCode;
      for (const listener of this.exitListeners) listener(exitCode);
    });
  }

  get exited(): boolean {
    return this.exitCode !== null;
  }

  /** Replays scrollback, then streams live output. Returns a detach function. */
  attach(onData: DataListener, onExit: ExitListener): () => void {
    const replay = this.scrollback.snapshot();
    if (replay) onData(replay);

    if (this.exitCode !== null) {
      onExit(this.exitCode);
      return () => {};
    }

    this.dataListeners.add(onData);
    this.exitListeners.add(onExit);
    return () => {
      this.dataListeners.delete(onData);
      this.exitListeners.delete(onExit);
    };
  }

  write(data: string): void {
    if (!this.exited) this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.exited) this.pty.resize(cols, rows);
  }

  kill(): void {
    if (!this.exited) this.pty.kill();
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly scrollbackLimit: number) {}

  create(spec: SessionSpec): Session {
    if (this.sessions.has(spec.id)) throw new Error(`session ${spec.id} already exists`);
    const session = new Session(spec, this.scrollbackLimit);
    this.sessions.set(spec.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  killAll(): void {
    for (const session of this.sessions.values()) session.kill();
    this.sessions.clear();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run helper/test/session.test.ts`
Expected: PASS (4 tests). If it fails with `posix_spawnp failed`, apply the `chmod` from Task 1 Step 2 and rerun.

- [ ] **Step 6: Commit**

```bash
git add helper/src/session.ts helper/test/session.test.ts helper/test/wait-for.ts
git commit -m "feat(helper): PTY sessions with attach/detach and replay

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: WebSocket server

**Files:**
- Create: `helper/src/server.ts`
- Test: `helper/test/server.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run helper/test/server.test.ts`
Expected: FAIL — cannot resolve `../src/server`.

- [ ] **Step 3: Write the implementation**

```ts
import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL, type ClientMessage, type ServerMessage } from '../../shared/protocol';
import { isAuthorized, tokenFromProtocols, type AuthPolicy } from './auth';
import type { Session, SessionManager } from './session';

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ServerOptions {
  host: string;
  port: number;
  auth: AuthPolicy;
  sessions: SessionManager;
  onUnknownSession?: (id: string) => Session | undefined;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const http = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  });

  http.on('upgrade', (req, socket, head) => {
    const token = tokenFromProtocols(req.headers['sec-websocket-protocol']);
    if (!isAuthorized(options.auth, req.headers.origin, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req.url ?? '/', options));
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => {
      const address = http.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : options.port,
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            http.close(() => done());
          }),
      });
    });
  });
}

function handleConnection(ws: WebSocket, url: string, options: ServerOptions): void {
  const { pathname, searchParams } = new URL(url, 'http://localhost');
  const id = searchParams.get('session');
  if (pathname !== '/attach' || !id || !SESSION_ID.test(id)) {
    ws.close(4400, 'bad request');
    return;
  }

  const session = options.sessions.get(id) ?? options.onUnknownSession?.(id);
  if (!session) {
    ws.close(4404, 'unknown session');
    return;
  }

  const send = (message: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  const detach = session.attach(
    (data) => send({ type: 'output', data }),
    (code) => send({ type: 'exit', code }),
  );

  ws.on('message', (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (message.type === 'input') session.write(message.data);
    else if (message.type === 'resize') session.resize(message.cols, message.rows);
  });
  ws.on('close', detach);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run helper/test/server.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add helper/src/server.ts helper/test/server.test.ts
git commit -m "feat(helper): authenticated websocket relay for sessions

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Native-messaging host

Chrome launches this as a subprocess and speaks length-prefixed JSON (4-byte little-endian length, then UTF-8 JSON) over stdio.

**Files:**
- Create: `helper/src/native-host.ts`
- Test: `helper/test/native-host.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { NativeHostReply } from '../../shared/protocol';
import { PORT } from '../src/config';

const HOST_SCRIPT = resolve(import.meta.dirname, '../src/native-host.ts');

function callHost(dataDir: string): Promise<NativeHostReply> {
  const child = spawn(process.execPath, ['--import', 'tsx', HOST_SCRIPT], {
    env: { ...process.env, CW_DATA_DIR: dataDir },
  });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));

  const body = Buffer.from(JSON.stringify({ type: 'hello' }));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header, body]));

  return new Promise((resolvePromise, reject) => {
    child.on('error', reject);
    child.on('close', () => {
      const out = Buffer.concat(chunks);
      resolvePromise(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString()) as NativeHostReply);
    });
  });
}

describe('native host', () => {
  it('replies with the token and helper port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-host-'));
    writeFileSync(join(dir, 'token'), `${'c'.repeat(64)}\n`);
    expect(await callHost(dir)).toEqual({ ok: true, token: 'c'.repeat(64), port: PORT });
  });

  it('reports an error when the helper has not created a token yet', async () => {
    const reply = await callHost(mkdtempSync(join(tmpdir(), 'cw-host-')));
    expect(reply.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run helper/test/native-host.test.ts`
Expected: FAIL — the child exits immediately (script missing), so parsing the empty output throws.

- [ ] **Step 3: Write the implementation**

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NativeHostReply } from '../../shared/protocol';
import { DATA_DIR, PORT } from './config';

let input = Buffer.alloc(0);
let answered = false;

function reply(message: NativeHostReply): void {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]), () => process.exit(0));
}

process.stdin.on('data', (chunk: Buffer) => {
  input = Buffer.concat([input, chunk]);
  if (answered || input.length < 4 || input.length < 4 + input.readUInt32LE(0)) return;
  answered = true;

  try {
    const token = readFileSync(join(DATA_DIR, 'token'), 'utf8').trim();
    reply({ ok: true, token, port: PORT });
  } catch (error) {
    reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run helper/test/native-host.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add helper/src/native-host.ts helper/test/native-host.test.ts
git commit -m "feat(helper): native-messaging host hands the token to the extension

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Helper entry point

**Files:**
- Create: `helper/src/main.ts`

- [ ] **Step 1: Write `helper/src/main.ts`**

```ts
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
```

- [ ] **Step 2: Verify typecheck and the full test suite**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0; vitest reports 6 files, 25 tests passed.

- [ ] **Step 3: Commit**

```bash
git add helper/src/main.ts
git commit -m "feat(helper): spike entry point

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Stable extension ID and local setup

An unpacked extension's ID comes from the manifest `key` (a base64 DER public key). Pinning it lets the helper and native-host manifest know the ID before Chrome loads the extension. Only the public key is kept; the private key is never written to disk.

**Files:**
- Create: `scripts/extension-id.ts`, `scripts/extension-id.test.ts`, `scripts/gen-key.ts`, `scripts/setup.ts`, `extension/manifest.json`

- [ ] **Step 1: Write the failing test**

`scripts/extension-id.test.ts`:
```ts
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extensionIdFromKey } from './extension-id';

const publicKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
}).publicKey.toString('base64');

describe('extensionIdFromKey', () => {
  it('produces 32 characters in Chrome’s a–p alphabet', () => {
    expect(extensionIdFromKey(publicKey)).toMatch(/^[a-p]{32}$/);
  });

  it('is deterministic for the same key', () => {
    expect(extensionIdFromKey(publicKey)).toBe(extensionIdFromKey(publicKey));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run scripts/extension-id.test.ts`
Expected: FAIL — cannot resolve `./extension-id`.

- [ ] **Step 3: Write `scripts/extension-id.ts`**

Chrome's ID is the first 32 hex digits of SHA-256(public key DER), with each digit 0–f mapped to a–p.

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function extensionIdFromKey(base64Key: string): string {
  const hex = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

export function extensionIdFromManifest(manifestPath: string): string {
  const { key } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { key?: string };
  if (!key) throw new Error(`${manifestPath} has no "key"; run npm run gen-key first`);
  return extensionIdFromKey(key);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run scripts/extension-id.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write `extension/manifest.json`**

No `suggested_key`s: invalid combinations make Chrome refuse to load the extension, and testing which combinations Chrome accepts is part of the spike (Task 11). Keys are assigned at `chrome://extensions/shortcuts`.

```json
{
  "manifest_version": 3,
  "name": "Chrome Workspaces",
  "version": "0.1.0",
  "description": "A terminal per Chrome window, in the side panel.",
  "permissions": ["sidePanel", "nativeMessaging", "storage"],
  "host_permissions": ["http://127.0.0.1/*"],
  "background": { "service_worker": "background.js", "type": "module" },
  "side_panel": { "default_path": "panel.html" },
  "action": { "default_title": "Chrome Workspaces" },
  "commands": {
    "_execute_action": { "description": "Open the workspace panel" },
    "next-workspace": { "description": "Next workspace" },
    "prev-workspace": { "description": "Previous workspace" }
  }
}
```

- [ ] **Step 6: Write `scripts/gen-key.ts`**

```ts
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { extensionIdFromKey } from './extension-id';

const MANIFEST = 'extension/manifest.json';
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;

if (typeof manifest.key === 'string') {
  console.log(`key already set; extension id ${extensionIdFromKey(manifest.key)}`);
} else {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const key = publicKey.toString('base64');
  writeFileSync(MANIFEST, `${JSON.stringify({ ...manifest, key }, null, 2)}\n`);
  console.log(`wrote key; extension id ${extensionIdFromKey(key)}`);
}
```

- [ ] **Step 7: Write `scripts/setup.ts`**

Writes three things outside the repo: `~/.chrome-workspaces/config.json`, `~/.chrome-workspaces/native-host.sh`, and Chrome's native-host manifest.

```ts
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { NATIVE_HOST_NAME } from '../shared/protocol';
import { DATA_DIR } from '../helper/src/config';
import { extensionIdFromManifest } from './extension-id';

const repo = resolve(import.meta.dirname, '..');
const extensionId = extensionIdFromManifest(join(repo, 'extension', 'manifest.json'));

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
writeFileSync(join(DATA_DIR, 'config.json'), `${JSON.stringify({ extensionId }, null, 2)}\n`);

// Chrome launches the host with an unknown cwd and a minimal PATH, so pin both.
const wrapper = join(DATA_DIR, 'native-host.sh');
writeFileSync(wrapper, `#!/bin/sh\ncd "${repo}" && exec "${process.execPath}" --import tsx helper/src/native-host.ts\n`);
chmodSync(wrapper, 0o755);

const hostsDir = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
mkdirSync(hostsDir, { recursive: true });
const hostManifest = join(hostsDir, `${NATIVE_HOST_NAME}.json`);
writeFileSync(
  hostManifest,
  `${JSON.stringify(
    {
      name: NATIVE_HOST_NAME,
      description: 'Chrome Workspaces token bridge',
      path: wrapper,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    null,
    2,
  )}\n`,
);

console.log(`extension id: ${extensionId}`);
console.log(`wrote ${join(DATA_DIR, 'config.json')}`);
console.log(`wrote ${wrapper}`);
console.log(`wrote ${hostManifest}`);
```

- [ ] **Step 8: Generate the key and run setup**

Run:
```bash
npm run gen-key && npm run setup
```
Expected: `wrote key; extension id <32 a–p chars>`, then setup prints the same ID and three `wrote` lines. Confirm with:
```bash
cat ~/.chrome-workspaces/config.json "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.chrome_workspaces.helper.json"
```

- [ ] **Step 9: Verify typecheck and tests**

Run: `npm run typecheck && npm test`
Expected: typecheck exits 0; 7 files, 27 tests passed.

- [ ] **Step 10: Commit**

```bash
git add scripts extension/manifest.json
git commit -m "feat: pinned extension id and local native-host setup

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: Spike extension

**Files:**
- Create: `extension/panel.html`, `extension/panel.css`, `extension/src/background.ts`, `extension/src/panel.ts`, `scripts/build-extension.ts`

- [ ] **Step 1: Write `extension/panel.html`**

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="xterm.css" />
    <link rel="stylesheet" href="panel.css" />
  </head>
  <body>
    <div id="status"></div>
    <div id="terminal"></div>
    <script type="module" src="panel.js"></script>
  </body>
</html>
```

- [ ] **Step 2: Write `extension/panel.css`**

```css
html,
body {
  margin: 0;
  height: 100%;
  background: #1e1e1e;
  color: #ccc;
  font: 11px -apple-system, sans-serif;
}

body {
  display: flex;
  flex-direction: column;
}

#status {
  padding: 4px 8px;
  border-bottom: 1px solid #333;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

#terminal {
  flex: 1;
  min-height: 0;
  padding: 4px;
}
```

- [ ] **Step 3: Write `extension/src/background.ts`**

```ts
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.commands.onCommand.addListener((command) => {
  // Lets the panel show which shortcut fired (spike risk 3). No open panel is fine.
  chrome.runtime.sendMessage({ type: 'command', command }).catch(() => {});
  if (command === 'next-workspace') void cycleWindows(1);
  if (command === 'prev-workspace') void cycleWindows(-1);
});

// Spike only: every normal window counts as a workspace, ordered by id.
// The next plan replaces this with the workspace list.
async function cycleWindows(step: 1 | -1): Promise<void> {
  const windows = (await chrome.windows.getAll({ windowTypes: ['normal'] })).sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const current = windows.findIndex((w) => w.focused);
  if (windows.length < 2 || current === -1) return;

  const from = windows[current];
  const to = windows[(current + step + windows.length) % windows.length];
  if (to.id === undefined) return;
  await chrome.windows.update(to.id, {
    focused: true,
    left: from.left,
    top: from.top,
    width: from.width,
    height: from.height,
  });
}
```

- [ ] **Step 4: Write `extension/src/panel.ts`**

```ts
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  NATIVE_HOST_NAME,
  PROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  type ClientMessage,
  type NativeHostReply,
  type ServerMessage,
} from '../../shared/protocol';

const statusEl = document.getElementById('status') as HTMLElement;
const terminalEl = document.getElementById('terminal') as HTMLElement;

const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 12, cursorBlink: true });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(terminalEl);
fit.fit();

let connection = 'connecting';
let lastShortcut = 'none';
let socket: WebSocket | null = null;

function renderStatus(): void {
  statusEl.textContent = `panel ${window.innerWidth}px · ${term.cols} cols · ${connection} · last shortcut: ${lastShortcut}`;
}

function sendToHelper(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

chrome.runtime.onMessage.addListener((message: { type?: string; command?: string }) => {
  if (message.type === 'command' && message.command) {
    lastShortcut = `${message.command} @ ${new Date().toLocaleTimeString()}`;
    renderStatus();
  }
});

term.onData((data) => sendToHelper({ type: 'input', data }));

new ResizeObserver(() => {
  fit.fit();
  sendToHelper({ type: 'resize', cols: term.cols, rows: term.rows });
  renderStatus();
}).observe(terminalEl);

async function connect(): Promise<void> {
  const reply = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: 'hello' })) as NativeHostReply;
  if (!reply.ok) throw new Error(reply.error);

  const { id: windowId } = await chrome.windows.getCurrent();
  const ws = new WebSocket(`ws://127.0.0.1:${reply.port}/attach?session=win-${windowId}`, [
    PROTOCOL,
    `${TOKEN_PROTOCOL_PREFIX}${reply.token}`,
  ]);
  socket = ws;

  ws.onopen = () => {
    connection = `attached win-${windowId}`;
    sendToHelper({ type: 'resize', cols: term.cols, rows: term.rows });
    renderStatus();
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    if (message.type === 'output') {
      term.write(message.data);
    } else {
      connection = `session exited (${message.code})`;
      renderStatus();
    }
  };
  ws.onclose = (event) => {
    connection = `disconnected (${event.code})`;
    renderStatus();
  };
}

renderStatus();
connect().catch((error: unknown) => {
  connection = `error: ${error instanceof Error ? error.message : String(error)}`;
  renderStatus();
});
```

- [ ] **Step 5: Write `scripts/build-extension.ts`**

```ts
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const OUT = 'extension/dist';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

await build({
  entryPoints: ['extension/src/background.ts', 'extension/src/panel.ts'],
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  outdir: OUT,
});

for (const file of ['manifest.json', 'panel.html', 'panel.css']) cpSync(`extension/${file}`, `${OUT}/${file}`);
cpSync('node_modules/@xterm/xterm/css/xterm.css', `${OUT}/xterm.css`);

console.log(`built ${OUT}`);
```

- [ ] **Step 6: Build and verify**

Run: `npm run typecheck && npm run build:extension && ls extension/dist`
Expected: typecheck exits 0; `built extension/dist`; listing shows `background.js manifest.json panel.css panel.html panel.js xterm.css`.

- [ ] **Step 7: Commit**

```bash
git add extension scripts/build-extension.ts
git commit -m "feat(extension): spike side panel terminal and window cycling

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Run the spike and record results

This task is hands-on in Mike's Chrome. An agent can prepare the steps and run the helper, but Mike performs the Chrome settings changes, extension loading, and shortcut assignment himself.

**Files:**
- Create: `docs/spike-results.md`

- [ ] **Step 1: Start the helper**

In a regular terminal (not the panel):
```bash
cd ~/Documents/Websites/chrome-workspaces && CW_SPIKE_CWD=~/Herd/pec-platform npm run helper
```
Expected: `chrome-workspaces helper on 127.0.0.1:4178 for extension <id>`.

- [ ] **Step 2: Mike sets up Chrome**

1. `chrome://settings/appearance` → side panel position → **Left**.
2. `chrome://extensions` → Developer mode on → **Load unpacked** → `~/Documents/Websites/chrome-workspaces/extension/dist`. Confirm the ID shown matches `~/.chrome-workspaces/config.json`.
3. `chrome://extensions/shortcuts` → Chrome Workspaces: Open panel `⌃⌥Space`, Next workspace `⌃⌥→`, Previous workspace `⌃⌥←`. Note whether Chrome accepts each; if not, note what it does accept.
4. Click the toolbar icon. The panel opens on the left, the status shows `attached win-<id>`, and a zsh prompt appears in `~/Herd/pec-platform`. Run `claude`.

If the status shows `error: Specified native messaging host not found`, rerun `npm run setup` and fully quit and reopen Chrome.

- [ ] **Step 3: Risk 1 — panel width**

Drag the panel's edge as wide as Chrome allows. Record the status line's `panel …px` and `… cols` at maximum, and the screen width. **Pass:** ≥ 650px (room for a 48px list rail plus ≥ 80 terminal columns).

- [ ] **Step 4: Risk 3 — shortcuts with the terminal focused**

Open two more windows (⌘N) and open the panel in each. Click into a terminal and press `⌃⌥→` several times, then `⌃⌥←`. Record: do windows switch, does `last shortcut` update, and do any stray characters appear in the shell? **Pass:** switches every time, no stray input.

- [ ] **Step 5: Persistence check**

In a window running `claude`, close the panel (toolbar icon), wait 30 seconds, reopen it. Record whether scrollback reappears and `claude` is still responsive. Repeat after switching away to another window for a few minutes.

- [ ] **Step 6: Risk 2 — Claude in Chrome targeting**

In two different windows' terminals, start `claude` and ask each to open `https://example.com` using Claude in Chrome. Record which window each session's tab group lands in.

- [ ] **Step 7: Write `docs/spike-results.md`**

Record every measurement from Steps 2–6 under these headings: **Shortcuts accepted**, **Panel width**, **Shortcuts with terminal focused**, **Persistence**, **Claude in Chrome targeting**, and **Decision** (continue with design B, or switch to the frame-app fallback). Include the exact numbers and observations, not just pass/fail.

- [ ] **Step 8: Commit**

```bash
git add docs/spike-results.md
git commit -m "docs: spike results for side panel, shortcuts, and Claude in Chrome

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

After this commit, write the next plan (workspace store, pairing, list UI, `devspace`, Mission Control, launchd) against the spike results.
