import { describe, expect, it } from 'vitest';
import { costOf, DEFAULT_PRICING, formatUsd, isRealModel, mergePricing, rateFor } from '../../shared/pricing';

const usage = (input: number, output: number, cacheWrite = 0, cacheRead = 0) => ({ input, output, cacheWrite, cacheRead });

describe('rateFor', () => {
  it('finds a family by a word in the model id, ignoring case, and has none for an unknown or synthetic model', () => {
    expect(rateFor('claude-opus-5-5', DEFAULT_PRICING)).toEqual(DEFAULT_PRICING.opus);
    expect(rateFor('Claude-Sonnet-4', DEFAULT_PRICING)).toEqual(DEFAULT_PRICING.sonnet);
    expect(rateFor('<synthetic>', DEFAULT_PRICING)).toBeNull();
    expect(rateFor('gpt-x', DEFAULT_PRICING)).toBeNull();
  });
});

describe('isRealModel', () => {
  it('is false for the placeholder and for no model, true for a named one', () => {
    expect([isRealModel('<synthetic>'), isRealModel(''), isRealModel('claude-fable-5-1')]).toEqual([false, false, true]);
    expect(rateFor('claude-fable-5-1', DEFAULT_PRICING)).not.toBeNull();
  });
});

describe('costOf', () => {
  const pricing = { opus: { input: 10, output: 50 } };

  it('prices input and output per million, cache writes at 1.25x and cache reads at 0.1x of input', () => {
    expect(costOf(usage(1_000_000, 0), 'claude-opus', pricing)).toBeCloseTo(10);
    expect(costOf(usage(0, 1_000_000), 'claude-opus', pricing)).toBeCloseTo(50);
    expect(costOf(usage(0, 0, 1_000_000), 'claude-opus', pricing)).toBeCloseTo(12.5);
    expect(costOf(usage(0, 0, 0, 1_000_000), 'claude-opus', pricing)).toBeCloseTo(1);
    expect(costOf(usage(1_000_000, 1_000_000, 1_000_000, 1_000_000), 'claude-opus', pricing)).toBeCloseTo(73.5);
  });

  it('is zero for a model with no rate', () => {
    expect(costOf(usage(5_000_000, 5_000_000), '<synthetic>', pricing)).toBe(0);
  });
});

describe('mergePricing', () => {
  it('overrides a family, adds one, and ignores anything malformed', () => {
    const merged = mergePricing({
      opus: { input: 5, output: 25 },
      mystery: { input: 2, output: 8 },
      sonnet: { input: 'x' },
      haiku: null,
      bad: { input: -1, output: 1 },
    });
    expect(merged.opus).toEqual({ input: 5, output: 25 });
    expect(merged.mystery).toEqual({ input: 2, output: 8 });
    expect(merged.sonnet).toEqual(DEFAULT_PRICING.sonnet);
    expect(merged.haiku).toEqual(DEFAULT_PRICING.haiku);
    expect(merged.bad).toBeUndefined();
  });

  it('is the defaults for nothing, or for something that is not an object', () => {
    for (const configured of [undefined, null, 'x', 5]) expect(mergePricing(configured)).toEqual(DEFAULT_PRICING);
  });
});

describe('formatUsd', () => {
  it('shows cents for small amounts and abbreviates large ones', () => {
    expect([0, 0.004, 0.5, 9.994, 12.4, 999, 1250, 20_000].map(formatUsd)).toEqual(['$0', '$0', '$0.50', '$9.99', '$12', '$999', '$1.3K', '$20.0K']);
  });
});
