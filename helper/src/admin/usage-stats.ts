import type { SystemSnapshot, UsageDay, UsageHour, UsageWorkspace } from '../../../shared/protocol/protocol';
import { localDayBack, USAGE_HISTORY_DAYS } from '../../../shared/usage/usage';

/** One day's use as it is added up, before it becomes a `UsageDay`. */
export type DayTotals = Omit<UsageDay, 'day' | 'models'> & { models: Map<string, { tokens: number; costUsd: number }> };

export const emptyDay = (): DayTotals => ({ tokens: 0, costUsd: 0, output: 0, cacheRead: 0, models: new Map() });

/** The last `USAGE_HISTORY_DAYS`, oldest first, with a day that had no usage shown as zero so the trend has no gaps. */
export function usageTrend(
  dayTotals: ReadonlyMap<string, DayTotals>,
  counting: boolean,
  unpriced: string[] = [],
  now = new Date(),
): Omit<SystemSnapshot['usage'], 'hourly' | 'workspaces'> {
  const daily: UsageDay[] = [];
  for (let back = USAGE_HISTORY_DAYS - 1; back >= 0; back--) {
    const day = localDayBack(now, back);
    const { models, ...totals } = dayTotals.get(day) ?? emptyDay();
    daily.push({ day, ...totals, models: [...models].map(([model, used]) => ({ model, ...used })) });
  }
  let costUsd = 0;
  for (const total of dayTotals.values()) costUsd += total.costUsd;
  return { daily, costUsd, counting, unpriced };
}

/** Today's use by hour, from the totals of each local hour that had any; every hour is listed so the chart has no gaps. */
export function usageByHour(hourTotals: ReadonlyMap<number, { tokens: number; costUsd: number }>): UsageHour[] {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, ...(hourTotals.get(hour) ?? { tokens: 0, costUsd: 0 }) }));
}

/** One row per workspace: a workspace with several transcripts (before and after a `/clear`) has its days added together. */
export function mergeWorkspaces(rows: readonly UsageWorkspace[]): UsageWorkspace[] {
  const merged = new Map<string, { name: string; days: Map<string, { tokens: number; costUsd: number }> }>();
  for (const { id, name, daily } of rows) {
    const into = merged.get(id) ?? { name, days: new Map() };
    for (const { day, tokens, costUsd } of daily) {
      const seen = into.days.get(day) ?? { tokens: 0, costUsd: 0 };
      seen.tokens += tokens;
      seen.costUsd += costUsd;
      into.days.set(day, seen);
    }
    merged.set(id, into);
  }
  return [...merged].map(([id, { name, days }]) => ({
    id,
    name,
    daily: [...days].map(([day, used]) => ({ day, ...used })).sort((a, b) => a.day.localeCompare(b.day)),
  }));
}
