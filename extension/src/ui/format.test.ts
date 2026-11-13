import { describe, expect, it } from 'vitest';
import { formatBytes, formatCpu, formatDuration, formatTokens, formatUsageShort, newTokens, resourceTotal } from './format';
import { makeSession, makeSnapshot } from '../../testing/fixtures';

describe('settings formatters', () => {
  it('abbreviates token counts', () => {
    expect([0, 999, 1000, 1234, 99_500, 123_456, 4_560_000, 1_250_000_000].map(formatTokens)).toEqual([
      '0',
      '999',
      '1.0K',
      '1.2K',
      '99.5K',
      '123K',
      '4.6M',
      '1.3B',
    ]);
  });

  it('counts input, output and cache writes as new tokens, and leaves out cache reads', () => {
    expect(newTokens({ input: 10, output: 20, cacheWrite: 30, cacheRead: 9999 })).toBe(60);
  });

  it('formats sizes and durations', () => {
    expect([0, 1023, 2048, 5 * 1024 * 1024].map(formatBytes)).toEqual(['0 B', '1023 B', '2.0 KB', '5.0 MB']);
    expect([45, 125, 3700, 90_000].map(formatDuration)).toEqual(['45s', '2m 5s', '1h 1m', '1d 1h']);
  });

  it('totals the helper and every workspace process, leaving CPU unknown from an older helper', () => {
    const snapshot = makeSnapshot({ sessions: [makeSession(), makeSession({ processes: [] })] });
    expect(resourceTotal(snapshot)).toEqual({ workspaceKb: 2048, workspaceCpu: 0.1, kb: 53_248, cpu: 1.6 });
    const older = makeSnapshot({ helper: { ...snapshot.helper, cpu: undefined } });
    expect(formatCpu(resourceTotal(older).cpu)).toBe('–');
  });

  it('shortens usage for the list header', () => {
    expect(formatUsageShort(1.1 * 1024 ** 2, 4.6)).toEqual(['1.1 GB', '5%']);
    expect(formatUsageShort(348_160, 0.2)).toEqual(['340 MB', '0%']);
    expect(formatUsageShort(1024, undefined)).toEqual(['1 MB', '–']);
  });
});
