import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHarness, TOKEN, type Harness } from '../helper/testing/harness';

const execFileAsync = promisify(execFile);
const SCRIPT = join(import.meta.dirname, 'cw.ts');

let h: Harness;
let dataDir: string;

beforeEach(async () => {
  h = await startHarness();
  dataDir = mkdtempSync(join(tmpdir(), 'cw-cli-'));
  writeFileSync(join(dataDir, 'token'), `${TOKEN}\n`);
});

afterEach(async () => {
  await h.close();
});

/** Runs the command line the way a user does, as its own process against the running helper. */
async function cw(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
      env: { ...process.env, CW_PORT: String(h.server.port), CW_DATA_DIR: dataDir },
      timeout: 20_000,
    });
    return { code: 0, out: stdout, err: stderr };
  } catch (error) {
    const { code, stdout, stderr } = error as { code: number; stdout: string; stderr: string };
    return { code, out: stdout, err: stderr };
  }
}

describe('cw', () => {
  it('lists, finds and archives a workspace, then restores it', async () => {
    const made = h.store.create({ name: 'acme-app', ticket: 'PROJ-123', cwd: h.defaultCwd });
    h.statuses[made.id] = 'working';

    const list = await cw('list');
    expect(list.code).toBe(0);
    expect(list.out).toContain(`${made.id}  working     acme-app (PROJ-123)`);

    expect((await cw('status', 'PROJ-123')).out).toContain('acme-app is working');

    const removed = await cw('rm', 'acme-app');
    expect(removed.out).toContain('Archived acme-app');
    expect(h.store.list()).toHaveLength(0);

    expect((await cw('archived')).out).toContain('acme-app (PROJ-123)');
    const restored = await cw('restore', 'acme-app');
    expect(restored.out).toContain('Restored acme-app');
    expect(h.store.list().map((w) => w.name)).toEqual(['acme-app']);
  });

  it('creates a workspace', async () => {
    const created = await cw('new', 'PROJ-9');
    expect(created.code).toBe(0);
    expect(created.out).toMatch(/^Created PROJ-9 \(ws-[0-9a-f]{8}\)/);
    expect(h.store.list().map((w) => w.name)).toEqual(['PROJ-9']);
  });

  it('says plainly what is wrong, and exits 1', async () => {
    const missing = await cw('status', 'nothing');
    expect(missing).toMatchObject({ code: 1, err: expect.stringContaining('No workspace is called nothing.') });

    const unknown = await cw('frobnicate');
    expect(unknown.code).toBe(1);
  });

  it('exits 2 when a wait times out, so a script can tell it from a finished turn', async () => {
    const made = h.store.create({ name: 'slow', cwd: h.defaultCwd });
    h.statuses[made.id] = 'working';
    const result = await cw('wait', 'slow', '--timeout', '1');
    expect(result.code).toBe(2);
    expect(result.out).toContain('slow is working');
  });

  it('says so when the helper is not listening', async () => {
    await h.close();
    const result = await cw('list');
    expect(result.code).toBe(1);
    expect(result.err).toContain('is not listening');
    h = await startHarness();
  });
});
