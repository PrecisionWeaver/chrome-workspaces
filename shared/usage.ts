import type { UsageDay } from './protocol';

/** The ranges Settings can show; `days` counts back from today, which is the last one. */
export const USAGE_RANGES = [
  { id: 'today', label: 'Today', days: 1 },
  { id: 'week', label: '7 days', days: 7 },
  { id: '14d', label: '14 days', days: 14 },
  { id: '30d', label: '30 days', days: 30 },
] as const;

export type UsageRangeId = (typeof USAGE_RANGES)[number]['id'];

export const DEFAULT_USAGE_RANGE: UsageRangeId = '14d';

/** The helper sends twice the longest range, so every range can be compared with the one before it. */
export const USAGE_HISTORY_DAYS = 60;

export interface ModelUsage {
  model: string;
  tokens: number;
  costUsd: number;
}

/** What a range of days added up to. */
export interface UsageSummary {
  days: number;
  /** New work: input, output and cache writes. Cache reads repeat earlier input, so they are counted apart. */
  tokens: number;
  costUsd: number;
  output: number;
  cacheRead: number;
  /** Days in the range with any use. */
  activeDays: number;
  busiest: UsageDay | null;
  /** Dearest first. */
  models: ModelUsage[];
  /** The same number of days just before, or null when nothing was used then, so there is nothing to compare with. */
  previous: { tokens: number; costUsd: number } | null;
}

const sum = (days: readonly UsageDay[], pick: (day: UsageDay) => number): number => days.reduce((total, day) => total + pick(day), 0);

/** Adds up the last `days` of `daily` (oldest first), and sets them beside the `days` before. */
export function summarizeUsage(daily: readonly UsageDay[], days: number): UsageSummary {
  const inRange = daily.slice(Math.max(0, daily.length - days));
  const before = daily.slice(Math.max(0, daily.length - 2 * days), Math.max(0, daily.length - days));

  const byModel = new Map<string, ModelUsage>();
  for (const day of inRange) {
    for (const { model, tokens, costUsd } of day.models) {
      const seen = byModel.get(model) ?? { model, tokens: 0, costUsd: 0 };
      seen.tokens += tokens;
      seen.costUsd += costUsd;
      byModel.set(model, seen);
    }
  }

  const used = (day: UsageDay) => day.tokens > 0 || day.costUsd > 0;
  const busiest = inRange.reduce<UsageDay | null>((best, day) => (used(day) && (!best || day.tokens > best.tokens) ? day : best), null);
  const previous = { tokens: sum(before, (d) => d.tokens), costUsd: sum(before, (d) => d.costUsd) };

  return {
    days,
    tokens: sum(inRange, (d) => d.tokens),
    costUsd: sum(inRange, (d) => d.costUsd),
    output: sum(inRange, (d) => d.output),
    cacheRead: sum(inRange, (d) => d.cacheRead),
    activeDays: inRange.filter(used).length,
    busiest,
    models: [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.model.localeCompare(b.model)),
    previous: previous.tokens > 0 || previous.costUsd > 0 ? previous : null,
  };
}

/**
 * How this range compares with the one before, as "↑ 23%": by cost when either has any, otherwise by tokens.
 * Null when there is nothing to compare with.
 */
export function usageChange(current: Pick<UsageSummary, 'tokens' | 'costUsd'>, previous: UsageSummary['previous']): string | null {
  if (!previous) return null;
  const byCost = current.costUsd > 0 || previous.costUsd > 0;
  const [now, then] = byCost ? [current.costUsd, previous.costUsd] : [current.tokens, previous.tokens];
  if (then <= 0) return null;
  const percent = Math.round(((now - then) / then) * 100);
  return percent === 0 ? '≈ the same' : `${percent > 0 ? '↑' : '↓'} ${Math.abs(percent)}%`;
}

/** What to call the range before this one: "yesterday", or "the previous 7 days". */
export const previousLabel = (days: number): string => (days === 1 ? 'yesterday' : `the previous ${days} days`);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-10-07` as "Oct 7", without asking the locale, since the day is already a UTC date. */
export function shortDay(day: string): string {
  const [, month, date] = day.split('-').map(Number);
  return month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${date}` : day;
}
