import type { TokenTotals } from './protocol';

/** Dollars per million input and output tokens for one model family. */
export interface Rate {
  input: number;
  output: number;
}

export type Pricing = Record<string, Rate>;

/**
 * Estimates, keyed by a word in the model's name. They are the published rates of earlier models in each
 * family, not the current ones, so every dollar figure the panel shows is labelled an estimate. Override
 * any of them under "pricing" in the config.
 */
export const DEFAULT_PRICING: Pricing = {
  opus: { input: 15, output: 75 },
  sonnet: { input: 3, output: 15 },
  haiku: { input: 1, output: 5 },
  // The top of the range, assumed to be priced like the largest model until a real rate is set.
  fable: { input: 15, output: 75 },
};

/** Writing to the prompt cache costs more than plain input, and reading from it far less. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** The rate for a model id such as `claude-opus-5-5`, or null for a model with none (e.g. a synthetic message). */
export function rateFor(model: string, pricing: Pricing): Rate | null {
  const lower = model.toLowerCase();
  const key = Object.keys(pricing).find((family) => lower.includes(family.toLowerCase()));
  return key ? pricing[key] : null;
}

/** A model id that names no real model, such as the placeholder Claude Code writes for its own messages. */
export const isRealModel = (model: string): boolean => model !== '' && !model.startsWith('<');

/** Estimated dollars for some usage on a model, 0 when the model has no rate. */
export function costOf(usage: TokenTotals, model: string, pricing: Pricing): number {
  const rate = rateFor(model, pricing);
  if (!rate) return 0;
  return (
    (usage.input * rate.input +
      usage.cacheWrite * rate.input * CACHE_WRITE_MULTIPLIER +
      usage.cacheRead * rate.input * CACHE_READ_MULTIPLIER +
      usage.output * rate.output) /
    1_000_000
  );
}

/** Config's pricing with anything malformed dropped, laid over the defaults. */
export function mergePricing(configured: unknown): Pricing {
  const merged: Pricing = { ...DEFAULT_PRICING };
  if (typeof configured !== 'object' || configured === null) return merged;
  for (const [family, rate] of Object.entries(configured as Record<string, unknown>)) {
    const r = rate as Partial<Rate> | null;
    if (r && typeof r.input === 'number' && typeof r.output === 'number' && r.input >= 0 && r.output >= 0 && Number.isFinite(r.input + r.output)) {
      merged[family] = { input: r.input, output: r.output };
    }
  }
  return merged;
}

export const formatUsd = (usd: number): string =>
  usd < 0.005 ? '$0' : usd < 10 ? `$${usd.toFixed(2)}` : usd < 1000 ? `$${usd.toFixed(0)}` : `$${(usd / 1000).toFixed(1)}K`;
