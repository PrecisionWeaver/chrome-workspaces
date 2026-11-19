import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const SCRIPT = join(import.meta.dirname, 'doctor.ts');

/** Runs the checks as a process, with the helper's data folder (and port) somewhere nothing is installed. */
async function doctor(dataDir: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', SCRIPT], {
      env: { ...process.env, CW_DATA_DIR: dataDir, CW_PORT: '1' },
      timeout: 60_000,
    });
    return { code: 0, out: stdout };
  } catch (error) {
    const { code, stdout } = error as { code: number; stdout: string };
    return { code, out: stdout };
  }
}

describe('npm run doctor', () => {
  it('reports each problem with how to fix it, and exits 1, when nothing is set up', async () => {
    const { code, out } = await doctor(join(mkdtempSync(join(tmpdir(), 'cw-doctor-')), 'none'));
    expect(code).toBe(1);
    expect(out).toMatch(/✓ Node 24 or newer/);
    expect(out).toMatch(/✗ Helper answering: Nothing at 127\.0\.0\.1:1[\s\S]*npm run agent:restart/);
    expect(out).toMatch(/\d+ problems? to fix\./);
  });

  it('names a config file it cannot read', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-doctor-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{ not json');
    const { out } = await doctor(dir);
    expect(out).toMatch(/✗ Config file:[\s\S]*Run npm run setup, or fix the JSON by hand\./);
  });
});
