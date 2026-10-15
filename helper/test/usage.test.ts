import { describe, expect, it } from 'vitest';
import type { UsageDay } from '../../shared/protocol';
import { localDay, localDayAndHour, localDayBack, previousLabel, shortDay, summarizeUsage, usageChange } from '../../shared/usage';

process.env.TZ = 'America/New_York';

const day = (n: number, tokens: number, costUsd = 0, extra: Partial<UsageDay> = {}): UsageDay => ({
  day: `2026-10-${String(n).padStart(2, '0')}`,
  tokens,
  costUsd,
  output: 0,
  cacheRead: 0,
  models: [],
  ...extra,
});

describe('summarizeUsage', () => {
  const week = [day(1, 10, 1), day(2, 20, 2), day(3, 0), day(4, 40, 4), day(5, 0), day(6, 60, 6), day(7, 100, 10)];

  it('adds up the last days, and counts those with any use', () => {
    const summary = summarizeUsage(week, 3);
    expect(summary).toMatchObject({ days: 3, tokens: 160, costUsd: 16, activeDays: 2 });
    expect(summarizeUsage(week, 7)).toMatchObject({ tokens: 230, costUsd: 23, activeDays: 5 });
  });

  it('finds the busiest day by tokens, and none when nothing was used', () => {
    expect(summarizeUsage(week, 7).busiest?.day).toBe('2026-10-07');
    expect(summarizeUsage(week, 3).busiest?.day).toBe('2026-10-07');
    expect(summarizeUsage([day(1, 0), day(2, 0)], 2).busiest).toBeNull();
  });

  it('sets the range beside the same number of days before it', () => {
    expect(summarizeUsage(week, 3).previous).toEqual({ tokens: 60, costUsd: 6 });
    expect(summarizeUsage(week, 1).previous).toEqual({ tokens: 60, costUsd: 6 });
  });

  it('has nothing to compare with when the days before were quiet or are missing', () => {
    expect(summarizeUsage([day(1, 0), day(2, 5, 1)], 1).previous).toBeNull();
    expect(summarizeUsage(week, 7).previous).toBeNull();
    expect(summarizeUsage([], 7)).toMatchObject({ tokens: 0, costUsd: 0, busiest: null, previous: null, models: [] });
  });

  it('adds up output and cache reads, and ranks models by what they cost', () => {
    const summary = summarizeUsage(
      [
        day(1, 30, 3, {
          output: 5,
          cacheRead: 100,
          models: [
            { model: 'sonnet', tokens: 20, costUsd: 1 },
            { model: 'opus', tokens: 10, costUsd: 2 },
          ],
        }),
        day(2, 30, 3, {
          output: 7,
          cacheRead: 50,
          models: [
            { model: 'sonnet', tokens: 25, costUsd: 1.5 },
            { model: 'haiku', tokens: 5, costUsd: 0.1 },
          ],
        }),
      ],
      2,
    );
    expect(summary).toMatchObject({ output: 12, cacheRead: 150 });
    expect(summary.models).toEqual([
      { model: 'sonnet', tokens: 45, costUsd: 2.5 },
      { model: 'opus', tokens: 10, costUsd: 2 },
      { model: 'haiku', tokens: 5, costUsd: 0.1 },
    ]);
  });

  it('ranks by tokens when nothing is priced', () => {
    const summary = summarizeUsage(
      [
        day(1, 30, 0, {
          models: [
            { model: 'a', tokens: 10, costUsd: 0 },
            { model: 'b', tokens: 20, costUsd: 0 },
          ],
        }),
      ],
      1,
    );
    expect(summary.models.map((m) => m.model)).toEqual(['b', 'a']);
  });
});

describe('usageChange', () => {
  const now = { tokens: 150, costUsd: 15 };

  it('is a rounded percentage by cost, up or down', () => {
    expect(usageChange(now, { tokens: 100, costUsd: 10 })).toBe('↑ 50%');
    expect(usageChange(now, { tokens: 100, costUsd: 30 })).toBe('↓ 50%');
  });

  it('says so when it is about the same', () => {
    expect(usageChange(now, { tokens: 100, costUsd: 14.95 })).toBe('≈ the same');
  });

  it('goes by tokens when neither range was priced', () => {
    expect(usageChange({ tokens: 300, costUsd: 0 }, { tokens: 100, costUsd: 0 })).toBe('↑ 200%');
  });

  it('is nothing when there is nothing to compare with, including a zero base', () => {
    expect(usageChange(now, null)).toBeNull();
    expect(usageChange(now, { tokens: 100, costUsd: 0 })).toBeNull();
  });
});

describe('labels', () => {
  it('names the range before, and formats a UTC day without asking the locale', () => {
    expect(previousLabel(1)).toBe('yesterday');
    expect(previousLabel(14)).toBe('the previous 14 days');
    expect(shortDay('2026-10-07')).toBe('Oct 7');
    expect(shortDay('2026-01-31')).toBe('Jan 31');
    expect(shortDay('garbage')).toBe('garbage');
  });
});

describe('local days', () => {
  it('names a date by the day it is on the machine, not in UTC', () => {
    // 02:30 UTC on the 8th is 22:30 on the 7th in Eastern time.
    expect(localDay(new Date('2026-10-08T02:30:00Z'))).toBe('2026-10-07');
    expect(localDay(new Date('2026-10-08T06:30:00Z'))).toBe('2026-10-08');
  });

  it('counts back by the calendar, so a clock change cannot skip or repeat a day', () => {
    // Clocks went back on 1 November 2026 (a 25-hour day) and forward on 8 March 2026 (a 23-hour one).
    const around = (from: string, days: number) => Array.from({ length: days }, (_, i) => localDayBack(new Date(from), i));
    expect(around('2026-11-03T17:00:00Z', 4)).toEqual(['2026-11-03', '2026-11-02', '2026-11-01', '2026-10-31']);
    expect(around('2026-03-10T17:00:00Z', 4)).toEqual(['2026-03-10', '2026-03-09', '2026-03-08', '2026-03-07']);
    expect(localDayBack(new Date('2026-03-01T17:00:00Z'), 30)).toBe('2026-01-30');
  });

  it('reads a timestamp as a local day and hour', () => {
    expect(localDayAndHour('2026-10-08T02:30:00Z')).toEqual({ day: '2026-10-07', hour: 22 });
    expect(localDayAndHour('2026-10-08')).toEqual({ day: '2026-10-08', hour: null });
    expect(localDayAndHour(12)).toBeNull();
    expect(localDayAndHour(undefined)).toBeNull();
  });
});
