import type { UsageDay, UsageWorkspace } from './protocol';

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

/** `2026-10-07` as "Oct 7", without asking the locale. */
export function shortDay(day: string): string {
  const [, month, date] = day.split('-').map(Number);
  return month >= 1 && month <= 12 ? `${MONTHS[month - 1]} ${date}` : day;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** A date's day in this machine's time zone, as `2026-10-07`. Days are the person's own, not UTC's. */
export const localDay = (date: Date): string => `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;

/** The day `back` days before `from`'s, by the calendar rather than by 24 hours, so a clock change cannot skip or repeat one. */
export const localDayBack = (from: Date, back: number): string => localDay(new Date(from.getFullYear(), from.getMonth(), from.getDate() - back, 12));

/**
 * When a transcript line was written, in this machine's time zone. Claude writes ISO 8601 in UTC (`…Z`), which is not
 * the day a person is living in. A bare date says which day but not which hour, and is already a calendar day, so it is
 * kept as written. Null for anything that is not a date.
 */
export function localDayAndHour(timestamp: unknown): { day: string; hour: number | null } | null {
  if (typeof timestamp !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(timestamp)) return { day: timestamp, hour: null };
  if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp)) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : { day: localDay(date), hour: date.getHours() };
}

/** What one workspace used over a range. */
export interface WorkspaceShare {
  id: string;
  name: string;
  tokens: number;
  costUsd: number;
}

/** Splits the last `days` of `daily` (the days the range covers) by workspace, dearest first, leaving out any that used nothing. */
export function summarizeWorkspaces(workspaces: readonly UsageWorkspace[], daily: readonly UsageDay[], days: number): WorkspaceShare[] {
  const inRange = new Set(daily.slice(Math.max(0, daily.length - days)).map((d) => d.day));
  const shares: WorkspaceShare[] = [];
  for (const { id, name, daily: own } of workspaces) {
    const share = { id, name, tokens: 0, costUsd: 0 };
    for (const d of own) {
      if (!inRange.has(d.day)) continue;
      share.tokens += d.tokens;
      share.costUsd += d.costUsd;
    }
    if (share.tokens > 0 || share.costUsd > 0) shares.push(share);
  }
  // With no rates there is no cost to rank by, so fall back to tokens.
  return shares.sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
}
