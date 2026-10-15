import { readFileSync } from 'node:fs';
import { planUsageOf } from '../../shared/plan-usage';
import type { PlanUsage } from '../../shared/protocol';

/** The plan's limits as `hooks/status-line.ts` last saved them; none when it has not, or the file cannot be read. */
export function readPlanUsage(file: string, now = Date.now()): PlanUsage {
  try {
    return planUsageOf(JSON.parse(readFileSync(file, 'utf8')), now);
  } catch {
    return { limits: [], updatedAt: null };
  }
}
