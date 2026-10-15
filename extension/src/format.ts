import type { TokenTotals } from '../../shared/protocol';

export const formatBytes = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : bytes < 1024 ** 3
        ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
        : `${(bytes / 1024 ** 3).toFixed(2)} GB`;

export const formatKb = (kb: number): string => formatBytes(kb * 1024);

/** A token count as 1.2K, 3.4M or 1.1B. */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const [value, unit] = count < 1e6 ? [count / 1e3, 'K'] : count < 1e9 ? [count / 1e6, 'M'] : [count / 1e9, 'B'];
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}${unit}`;
}

/** Tokens that were new work: everything but reads of the prompt cache, which are repeats of earlier input. */
export const newTokens = (t: TokenTotals): number => t.input + t.output + t.cacheWrite;

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${seconds % 60}s` : `${seconds}s`;
}
