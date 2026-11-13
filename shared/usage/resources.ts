import type { ResourceSample, SystemSession } from '../protocol/protocol';

/** What every running workspace was using together in one minute. */
export interface CombinedSample {
  /** Epoch milliseconds of the start of the minute. */
  t: number;
  rssKb: number;
  /** Summed across workspaces, so it can pass 100 on several cores. */
  cpu: number;
  /** How many workspaces were sampled in it. */
  sessions: number;
}

const MINUTE_MS = 60_000;

/**
 * Adds the workspaces' histories together, minute by minute, oldest first. Each session is sampled on its own clock,
 * so samples are grouped by the minute they fall in. A session that stopped has no history left, and one that started
 * later has none before then, so the total moves as workspaces come and go.
 */
export function combineHistory(sessions: readonly Pick<SystemSession, 'history'>[]): CombinedSample[] {
  const buckets = new Map<number, CombinedSample>();
  for (const { history } of sessions) {
    // One session can land two samples in a minute; the later one stands for it.
    const own = new Map<number, ResourceSample>();
    for (const sample of history) own.set(Math.floor(sample.t / MINUTE_MS), sample);
    for (const [minute, sample] of own) {
      const sum = buckets.get(minute) ?? { t: minute * MINUTE_MS, rssKb: 0, cpu: 0, sessions: 0 };
      sum.rssKb += sample.rssKb;
      sum.cpu += sample.cpu;
      sum.sessions += 1;
      buckets.set(minute, sum);
    }
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, sum]) => sum);
}

/** A running workspace and what its processes are using now. */
export interface Consumer {
  id: string;
  name: string;
  rssKb: number;
  cpu: number;
}

/** The `count` running workspaces using the most memory right now, biggest first. */
export function topConsumers(sessions: readonly SystemSession[], count: number): Consumer[] {
  return sessions
    .filter((s) => s.pid !== null)
    .map((s) => ({ id: s.id, name: s.name, rssKb: s.processes.reduce((sum, p) => sum + p.rssKb, 0), cpu: s.processes.reduce((sum, p) => sum + p.cpu, 0) }))
    .sort((a, b) => b.rssKb - a.rssKb || b.cpu - a.cpu || a.name.localeCompare(b.name))
    .slice(0, count);
}
