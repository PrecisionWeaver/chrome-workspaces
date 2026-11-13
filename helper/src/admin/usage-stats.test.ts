import { describe, expect, it } from 'vitest';
import { emptyDay, mergeWorkspaces, usageByHour, usageTrend } from './usage-stats';

// The trend test names days, so it needs a known zone.
process.env.TZ = 'America/New_York';

describe('mergeWorkspaces', () => {
  it('merges the days of one workspace counted from several transcripts', () => {
    expect(
      mergeWorkspaces([
        { id: 'w-1', name: 'acme/app', daily: [{ day: '2026-10-08', tokens: 1, costUsd: 1 }] },
        { id: 'w-2', name: 'other', daily: [{ day: '2026-10-08', tokens: 5, costUsd: 5 }] },
        {
          id: 'w-1',
          name: 'old name',
          daily: [
            { day: '2026-10-07', tokens: 2, costUsd: 2 },
            { day: '2026-10-08', tokens: 4, costUsd: 4 },
          ],
        },
      ]),
    ).toEqual([
      {
        id: 'w-1',
        name: 'acme/app',
        daily: [
          { day: '2026-10-07', tokens: 2, costUsd: 2 },
          { day: '2026-10-08', tokens: 5, costUsd: 5 },
        ],
      },
      { id: 'w-2', name: 'other', daily: [{ day: '2026-10-08', tokens: 5, costUsd: 5 }] },
    ]);
  });
});

describe('usageTrend', () => {
  it("builds a 60-day series ending today, and sums every day's cost", () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const day = (tokens: number, costUsd: number, models: [string, number, number][] = []) => ({
      ...emptyDay(),
      tokens,
      costUsd,
      output: tokens / 2,
      cacheRead: 7,
      models: new Map(models.map(([model, t, c]) => [model, { tokens: t, costUsd: c }])),
    });
    const trend = usageTrend(
      new Map([
        ['2026-10-09', day(5, 2, [['opus', 5, 2]])],
        ['2026-10-01', day(3, 1.5)],
        ['2025-01-01', day(9, 4)],
      ]),
      true,
      ['mystery-1'],
      now,
    );
    expect(trend.daily).toHaveLength(60);
    expect(trend.daily[0].day).toBe('2026-08-11');
    expect(trend.daily.at(-1)).toEqual({
      day: '2026-10-09',
      tokens: 5,
      costUsd: 2,
      output: 2.5,
      cacheRead: 7,
      models: [{ model: 'opus', tokens: 5, costUsd: 2 }],
    });
    expect(trend.daily.find((d) => d.day === '2026-10-01')).toMatchObject({ tokens: 3, models: [] });
    expect(trend.daily.find((d) => d.day === '2026-10-02')).toEqual({ day: '2026-10-02', tokens: 0, costUsd: 0, output: 0, cacheRead: 0, models: [] });
    // The total includes older days too; the series only reaches back sixty.
    expect(trend).toMatchObject({ costUsd: 7.5, counting: true, unpriced: ['mystery-1'] });
  });

  it('starts from an empty day with nothing counted and no models', () => {
    expect(emptyDay()).toEqual({ tokens: 0, costUsd: 0, output: 0, cacheRead: 0, models: new Map() });
    const trend = usageTrend(new Map(), false);
    expect(trend.daily).toHaveLength(60);
    expect(trend.daily.every((d) => d.tokens === 0 && d.models.length === 0)).toBe(true);
    expect(trend).toMatchObject({ costUsd: 0, counting: false, unpriced: [] });
  });
});

describe('usageByHour', () => {
  it('lists all 24 hours, with those that had no use at zero', () => {
    const hours = usageByHour(
      new Map([
        [3, { tokens: 5, costUsd: 1 }],
        [23, { tokens: 7, costUsd: 0 }],
      ]),
    );
    expect(hours).toHaveLength(24);
    expect(hours.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(hours[3]).toEqual({ hour: 3, tokens: 5, costUsd: 1 });
    expect(hours[23]).toEqual({ hour: 23, tokens: 7, costUsd: 0 });
    expect(hours[4]).toEqual({ hour: 4, tokens: 0, costUsd: 0 });
  });
});
