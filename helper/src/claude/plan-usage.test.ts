import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLAN_USAGE_FILE } from '../../../shared/usage/plan-usage';
import { readPlanUsage } from './plan-usage';

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const at = (minutes: number) => Math.floor(NOW / 1000) + minutes * 60;

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
