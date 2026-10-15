import type { PlanLimit, PlanUsage } from './protocol';

/** Where the status line wrapper keeps what claude last told it, in the data directory. */
export const PLAN_USAGE_FILE = 'plan-usage.json';

/** The windows claude reports in `rate_limits`, in the order `/usage` lists them; anything else is ignored. */
const WINDOWS = [
  { id: 'five_hour', label: 'Current session' },
  { id: 'seven_day', label: 'Current week' },
  { id: 'spend_limit', label: 'Spend limit' },
] as const;

export interface RateWindow {
  used_percentage: number;
  /** Unix epoch seconds. */
  resets_at: number;
  /** A spend limit's dollars and period, which claude sends on their own schedule and can leave out. */
  used_usd?: number;
  limit_usd?: number;
  period?: 'daily' | 'weekly' | 'monthly';
}

const PERIODS = ['daily', 'weekly', 'monthly'];

/** What `hooks/status-line.ts` saves: the newest figure for each window, and when one last arrived. */
export interface PlanUsageFile {
  saved_at: string;
  rate_limits: Record<string, RateWindow>;
}

function windowOf(value: unknown): RateWindow | null {
  if (typeof value !== 'object' || value === null) return null;
  const { used_percentage, resets_at, used_usd, limit_usd, period } = value as Record<string, unknown>;
  if (typeof used_percentage !== 'number' || !Number.isFinite(used_percentage)) return null;
  if (typeof resets_at !== 'number' || !Number.isFinite(resets_at)) return null;
  const found: RateWindow = { used_percentage, resets_at };
  if (typeof used_usd === 'number' && Number.isFinite(used_usd) && typeof limit_usd === 'number' && Number.isFinite(limit_usd) && limit_usd > 0) {
    found.used_usd = used_usd;
    found.limit_usd = limit_usd;
    if (typeof period === 'string' && PERIODS.includes(period)) found.period = period as RateWindow['period'];
  }
  return found;
}

/**
 * The windows in claude's `rate_limits`, laid over those saved before: a message that carries only one window
 * leaves the other as it was, until its own reset time passes.
 */
export function mergeRateLimits(saved: unknown, incoming: unknown): Record<string, RateWindow> {
  const merged: Record<string, RateWindow> = {};
  for (const source of [saved, incoming]) {
    if (typeof source !== 'object' || source === null) continue;
    for (const { id } of WINDOWS) {
      const found = windowOf((source as Record<string, unknown>)[id]);
      if (!found) continue;
      // The dollars come about five minutes apart from the percentage, so a message without them keeps the last ones for the same period.
      const before = merged[id];
      if (found.used_usd === undefined && before?.used_usd !== undefined && before.resets_at === found.resets_at) {
        found.used_usd = before.used_usd;
        found.limit_usd = before.limit_usd;
        found.period = before.period;
      }
      merged[id] = found;
    }
  }
  return merged;
}

/** The saved file as the limits still running at `now`: a window past its reset time is out of date, so it is left out. */
export function planUsageOf(file: unknown, now: number): PlanUsage {
  const none: PlanUsage = { limits: [], updatedAt: null };
  if (typeof file !== 'object' || file === null) return none;
  const { saved_at, rate_limits } = file as { saved_at?: unknown; rate_limits?: unknown };
  const windows = mergeRateLimits(null, rate_limits);
  const limits: PlanLimit[] = [];
  for (const { id, label } of WINDOWS) {
    const found = windows[id];
    if (!found || found.resets_at * 1000 <= now) continue;
    const limit: PlanLimit = { id, label, percent: Math.max(0, found.used_percentage), resetsAt: new Date(found.resets_at * 1000).toISOString() };
    if (found.used_usd !== undefined && found.limit_usd !== undefined && found.period) {
      limit.spend = { usedUsd: found.used_usd, limitUsd: found.limit_usd, period: found.period };
    }
    limits.push(limit);
  }
  return { limits, updatedAt: limits.length && typeof saved_at === 'string' ? saved_at : null };
}

/** "Resets in 2h 10m" within a day, otherwise "Resets Tue 3:00 PM", in the person's own time. */
export function resetLabel(resetsAt: string, now: number): string {
  const at = Date.parse(resetsAt);
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes <= 0) return 'Resetting now';
  if (minutes < 60) return `Resets in ${minutes}m`;
  if (minutes < 24 * 60) return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const date = new Date(at);
  const day = date.toLocaleDateString(undefined, { weekday: 'short' });
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `Resets ${day} ${time}`;
}
