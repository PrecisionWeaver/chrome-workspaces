import type { SystemSession } from './protocol';

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

const mb = (kb: number): string => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);

/**
 * What is worth telling the user about the running workspaces: one that holds a lot of memory, and a
 * server that has been listening on a port for hours without using any CPU. CPU is a snapshot, so
 * "idle" means idle now, and only a server that has also been up a long time is reported.
 */
export function findWarnings(sessions: readonly SystemSession[], limits: Limits = DEFAULT_LIMITS): GuardrailWarning[] {
  const warnings: GuardrailWarning[] = [];
  for (const session of sessions) {
    const rssKb = session.processes.reduce((sum, p) => sum + p.rssKb, 0);
    if (rssKb > limits.memoryWarnMb * 1024) {
      warnings.push({ id: session.id, name: session.name, kind: 'memory', message: `${session.name} is using ${mb(rssKb)} across ${session.processes.length} processes` });
    }
    // The shell itself is never a server, and is first in the list.
    for (const proc of session.processes.slice(1)) {
      if (proc.ports.length === 0 || proc.cpu >= 0.5) continue;
      if (parseElapsed(proc.elapsed) < limits.idleServerHours * 3600) continue;
      warnings.push({
        id: session.id,
        name: session.name,
        kind: 'idle-server',
        pid: proc.pid,
        message: `${session.name} has had :${proc.ports[0]} open for ${proc.elapsed.includes('-') ? `${proc.elapsed.split('-')[0]}d` : `${Math.floor(parseElapsed(proc.elapsed) / 3600)}h`} without using any CPU`,
      });
    }
  }
  return warnings;
}
