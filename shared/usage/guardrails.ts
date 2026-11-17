import type { SystemSession } from '../protocol/system';

export interface Limits {
  /** A workspace whose processes together hold more than this is flagged. */
  memoryWarnMb: number;
  /** A process listening on a port, doing nothing for longer than this, is flagged as a forgotten dev server. */
  idleServerHours: number;
}

export const DEFAULT_LIMITS: Limits = { memoryWarnMb: 4096, idleServerHours: 4 };

export interface GuardrailWarning {
  /** The workspace it concerns. */
  id: string;
  name: string;
  kind: 'memory' | 'idle-server';
  message: string;
  /** The process to stop for an idle server. */
  pid?: number;
}

/** Seconds in a `ps` elapsed time, `[[dd-]hh:]mm:ss`; 0 when it is not in that form. */
export function parseElapsed(etime: string): number {
  const m = etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return 0;
  const [, d = '0', h = '0', min, s] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s);
}

/** A memory warning already raised stays until the workspace drops below this share of the limit. */
const MEMORY_CLEAR_SHARE = 0.9;
/** An idle-server warning already raised stays until the server uses at least this much CPU. */
const IDLE_CLEAR_CPU = 5;
const IDLE_CPU = 0.5;

/** What names a warning across snapshots, and what a dismissal is remembered by. */
export const warningKey = (w: Pick<GuardrailWarning, 'kind' | 'id' | 'pid'>): string => `${w.kind}:${w.id}:${w.pid ?? ''}`;

const mb = (kb: number): string => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);

/**
 * What is worth telling the user about the running workspaces: one that holds a lot of memory, and a
 * server that has been listening on a port for hours without using any CPU (the message says it looks
 * forgotten, not that it uses no CPU). CPU is a snapshot, so
 * "idle" means idle now, and only a server that has also been up a long time is reported.
 * A warning in `previous` is held until its reading is clearly back to normal, so one that sits near
 * its threshold does not come and go with every snapshot.
 */
export function findWarnings(
  sessions: readonly SystemSession[],
  limits: Limits = DEFAULT_LIMITS,
  previous: readonly GuardrailWarning[] = [],
): GuardrailWarning[] {
  const raised = new Set(previous.map(warningKey));
  const warnings: GuardrailWarning[] = [];
  for (const session of sessions) {
    const rssKb = session.processes.reduce((sum, p) => sum + p.rssKb, 0);
    const memoryLimit = limits.memoryWarnMb * 1024 * (raised.has(warningKey({ kind: 'memory', id: session.id })) ? MEMORY_CLEAR_SHARE : 1);
    if (rssKb > memoryLimit) {
      warnings.push({
        id: session.id,
        name: session.name,
        kind: 'memory',
        message: `${session.name} is using ${mb(rssKb)} across ${session.processes.length} processes`,
      });
    }
    // The shell itself is never a server, and is first in the list.
    for (const proc of session.processes.slice(1)) {
      const held = raised.has(warningKey({ kind: 'idle-server', id: session.id, pid: proc.pid }));
      if (proc.ports.length === 0 || proc.cpu >= (held ? IDLE_CLEAR_CPU : IDLE_CPU)) continue;
      if (parseElapsed(proc.elapsed) < limits.idleServerHours * 3600) continue;
      warnings.push({
        id: session.id,
        name: session.name,
        kind: 'idle-server',
        pid: proc.pid,
        message: `${session.name} has had a server on :${proc.ports[0]} running for ${proc.elapsed.includes('-') ? `${proc.elapsed.split('-')[0]}d` : `${Math.floor(parseElapsed(proc.elapsed) / 3600)}h`}, and it looks forgotten`,
      });
    }
  }
  return warnings;
}
