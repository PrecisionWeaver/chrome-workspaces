import type { SystemSnapshot, TokenTotals } from '../../shared/protocol';

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

/** Memory and CPU of the helper plus every workspace's processes. CPU is undefined from an older helper that does not report its own. */
export function resourceTotal(s: SystemSnapshot): { workspaceKb: number; workspaceCpu: number; kb: number; cpu: number | undefined } {
  const procs = s.sessions.flatMap((x) => x.processes);
  const workspaceKb = procs.reduce((sum, p) => sum + p.rssKb, 0);
  const workspaceCpu = procs.reduce((sum, p) => sum + p.cpu, 0);
  return { workspaceKb, workspaceCpu, kb: s.helper.rssKb + workspaceKb, cpu: s.helper.cpu === undefined ? undefined : s.helper.cpu + workspaceCpu };
}

/** An older helper does not report its own CPU, so this takes undefined rather than failing the whole render. */
export const formatCpu = (cpu: number | undefined): string => (cpu === undefined ? '–' : `${cpu.toFixed(1)}%`);

/** Memory and CPU at a glance, for the list header: 1.1 GB or 340 MB, and whole percents. */
export function formatUsageShort(kb: number, cpu: number | undefined): [string, string] {
  const memory = kb >= 1024 ** 2 ? `${(kb / 1024 ** 2).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;
  return [memory, cpu === undefined ? '–' : `${Math.round(cpu)}%`];
}

/** What the total is made of, and why it reads a little high, as a tooltip. */
export function resourceTitle(s: SystemSnapshot): string {
  return `Helper ${formatKb(s.helper.rssKb)} + workspaces ${formatKb(resourceTotal(s).workspaceKb)}\nMemory shared between processes is counted once per process, so this is slightly high.\nCPU is a percentage of one core, so it can pass 100 across several cores.`;
}

export function formatDuration(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${seconds % 60}s` : `${seconds}s`;
}
