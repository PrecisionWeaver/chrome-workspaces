import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mergeRateLimits, PLAN_USAGE_FILE, planUsageOf, resetLabel } from '../../shared/plan-usage';
import { STATUS_LINE_SCRIPT } from '../src/hooks-config';
import { readPlanUsage } from '../src/plan-usage';

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const at = (minutes: number) => Math.floor(NOW / 1000) + minutes * 60;

describe('mergeRateLimits', () => {
  it('keeps a window the newest message left out, and ignores what is not a window', () => {
    const saved = { five_hour: { used_percentage: 10, resets_at: at(60) }, seven_day: { used_percentage: 40, resets_at: at(5000) } };
    expect(mergeRateLimits(saved, { five_hour: { used_percentage: 12, resets_at: at(60) }, other: { used_percentage: 1, resets_at: 1 } })).toEqual({
      five_hour: { used_percentage: 12, resets_at: at(60) },
      seven_day: { used_percentage: 40, resets_at: at(5000) },
    });
  });

  it("keeps a spend limit's dollars across a message that has only the percentage, until its period turns over", () => {
    const dollars = { used_percentage: 60, resets_at: at(900), used_usd: 30, limit_usd: 50, period: 'weekly' };
    expect(mergeRateLimits({ spend_limit: dollars }, { spend_limit: { used_percentage: 64, resets_at: at(900) } })).toEqual({
      spend_limit: { ...dollars, used_percentage: 64 },
    });
    expect(mergeRateLimits({ spend_limit: dollars }, { spend_limit: { used_percentage: 1, resets_at: at(9000) } })).toEqual({
      spend_limit: { used_percentage: 1, resets_at: at(9000) },
    });
  });

  it('ignores dollars that are not a usable amount and period', () => {
    expect(mergeRateLimits(null, { spend_limit: { used_percentage: 5, resets_at: at(9), used_usd: 1, limit_usd: 0, period: 'daily' } })).toEqual({
      spend_limit: { used_percentage: 5, resets_at: at(9) },
    });
  });

  it('skips a window that is missing a figure', () => {
    expect(mergeRateLimits(null, { five_hour: { used_percentage: '10', resets_at: at(1) }, seven_day: { used_percentage: 5 } })).toEqual({});
    expect(mergeRateLimits('nope', undefined)).toEqual({});
  });
});

describe('planUsageOf', () => {
  it("carries a spend limit's dollars and period", () => {
    const file = {
      saved_at: '2026-03-10T11:58:00.000Z',
      rate_limits: { spend_limit: { used_percentage: 112, resets_at: at(60), used_usd: 56, limit_usd: 50, period: 'monthly' } },
    };
    expect(planUsageOf(file, NOW).limits).toEqual([
      { id: 'spend_limit', label: 'Spend limit', percent: 112, resetsAt: '2026-03-10T13:00:00.000Z', spend: { usedUsd: 56, limitUsd: 50, period: 'monthly' } },
    ]);
  });

  it('lists the windows in /usage order with their reset times, and drops one whose reset has passed', () => {
    const file = {
      saved_at: '2026-03-10T11:58:00.000Z',
      rate_limits: { seven_day: { used_percentage: 41.2, resets_at: at(3000) }, five_hour: { used_percentage: 23.5, resets_at: at(130) } },
    };
    expect(planUsageOf(file, NOW)).toEqual({
      limits: [
        { id: 'five_hour', label: 'Current session', percent: 23.5, resetsAt: '2026-03-10T14:10:00.000Z' },
        { id: 'seven_day', label: 'Current week', percent: 41.2, resetsAt: '2026-03-12T14:00:00.000Z' },
      ],
      updatedAt: '2026-03-10T11:58:00.000Z',
    });
    const stale = { ...file, rate_limits: { ...file.rate_limits, five_hour: { used_percentage: 99, resets_at: at(-1) } } };
    expect(planUsageOf(stale, NOW).limits.map((l) => l.id)).toEqual(['seven_day']);
  });

  it('is empty for anything that is not the saved file', () => {
    expect(planUsageOf(null, NOW)).toEqual({ limits: [], updatedAt: null });
    expect(planUsageOf({ saved_at: 'x', rate_limits: { five_hour: { used_percentage: 1, resets_at: at(-5) } } }, NOW)).toEqual({ limits: [], updatedAt: null });
  });
});

describe('resetLabel', () => {
  it.each([
    [0, 'Resetting now'],
    [-5, 'Resetting now'],
    [45, 'Resets in 45m'],
    [130, 'Resets in 2h 10m'],
  ])('%d minutes ahead reads %s', (minutes, label) => expect(resetLabel(new Date(NOW + minutes * 60_000).toISOString(), NOW)).toBe(label));

  it('names the day and time beyond a day', () => {
    expect(resetLabel(new Date(NOW + 3 * 24 * 3600_000).toISOString(), NOW)).toMatch(/^Resets \w{3} \d{1,2}:\d{2}/);
  });
});

describe('readPlanUsage', () => {
  it('reads the saved file, and is empty when there is none or it is not JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-plan-'));
    const file = join(dir, PLAN_USAGE_FILE);
    expect(readPlanUsage(file, NOW)).toEqual({ limits: [], updatedAt: null });
    writeFileSync(file, '{');
    expect(readPlanUsage(file, NOW)).toEqual({ limits: [], updatedAt: null });
    writeFileSync(file, JSON.stringify({ saved_at: 'then', rate_limits: { five_hour: { used_percentage: 5, resets_at: at(10) } } }));
    expect(readPlanUsage(file, NOW).limits).toHaveLength(1);
  });
});

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
