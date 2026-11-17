import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STATUS_LINE_SCRIPT } from '../helper/src/claude/hooks-config';
import { PLAN_USAGE_FILE } from '../shared/usage/plan-usage';

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const at = (minutes: number) => Math.floor(NOW / 1000) + minutes * 60;

describe('hooks/status-line.ts', () => {
  /** Runs it the way claude does: a real process, claude's JSON on stdin, and a status line of the person's own to pass on to. */
  function run(input: unknown, statusLine?: string) {
    const data = mkdtempSync(join(tmpdir(), 'cw-status-'));
    const claude = mkdtempSync(join(tmpdir(), 'cw-claude-'));
    mkdirSync(claude, { recursive: true });
    if (statusLine) writeFileSync(join(claude, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: statusLine } }));
    const result = spawnSync(process.execPath, [STATUS_LINE_SCRIPT], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      env: { ...process.env, CW_DATA_DIR: data, CLAUDE_CONFIG_DIR: claude },
      encoding: 'utf8',
    });
    return { result, saved: () => JSON.parse(readFileSync(join(data, PLAN_USAGE_FILE), 'utf8')), data };
  }

  it('saves the rate limits and prints what the status line already in place prints', () => {
    const { result, saved } = run({ model: 'x', rate_limits: { five_hour: { used_percentage: 12, resets_at: at(60) } } }, 'jq -r .model');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('x');
    expect(saved().rate_limits).toEqual({ five_hour: { used_percentage: 12, resets_at: at(60) } });
  });

  it('prints nothing and saves nothing when there is neither a status line nor rate limits', () => {
    const { result, data } = run({ model: 'x' });
    expect(result).toMatchObject({ status: 0, stdout: '' });
    expect(() => readFileSync(join(data, PLAN_USAGE_FILE))).toThrow();
  });

  it('still exits 0 for input that is not JSON', () => {
    expect(run('not json', 'echo hi').result.status).toBe(0);
  });
});
