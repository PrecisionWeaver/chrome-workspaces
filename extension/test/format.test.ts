import { describe, expect, it } from 'vitest';
import { formatBytes, formatDuration, formatTokens, newTokens } from '../src/format';

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
});
