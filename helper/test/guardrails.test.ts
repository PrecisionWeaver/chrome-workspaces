import { describe, expect, it } from 'vitest';
import type { SystemProcess, SystemSession } from '../../shared/protocol';
import { findWarnings, parseElapsed } from '../../shared/guardrails';

const proc = (pid: number, extra: Partial<SystemProcess> = {}): SystemProcess => ({
  pid,
  ppid: 1,
  command: `p${pid}`,
  cpu: 0,
  rssKb: 1000,
  elapsed: '00:10',
  ports: [],
  ...extra,
});
const session = (name: string, processes: SystemProcess[]): SystemSession => ({
  id: `ws-${name}`,
  name,
  pid: 1,
  status: null,
  cwd: '/tmp',
  cwdMissing: false,
  claudeSessionId: null,
  tokens: null,
  processes,
});
const limits = { memoryWarnMb: 100, idleServerHours: 2 };

describe('parseElapsed', () => {
  it('reads every form ps prints', () => {
    expect([parseElapsed('05:09'), parseElapsed('01:05:09'), parseElapsed('2-03:04:05')]).toEqual([309, 3909, 183845]);
    expect(parseElapsed('garbage')).toBe(0);
    expect(parseElapsed('')).toBe(0);
  });
});

describe('findWarnings', () => {
  it('flags a workspace over the memory limit, counting every process in it', () => {
    const big = session('big', [proc(1, { rssKb: 60 * 1024 }), proc(2, { rssKb: 60 * 1024 })]);
    const small = session('small', [proc(3, { rssKb: 10 * 1024 })]);
    expect(findWarnings([big, small], limits)).toEqual([expect.objectContaining({ id: 'ws-big', kind: 'memory', message: expect.stringContaining('120 MB') })]);
  });

  it('flags a server that has listened for hours doing nothing, naming its process, and not a busy or recent one', () => {
    const s = session('dev', [
      proc(1),
      proc(2, { ports: [5173], elapsed: '03:00:00' }),
      proc(3, { ports: [8000], elapsed: '03:00:00', cpu: 35 }),
      proc(4, { ports: [9000], elapsed: '00:30:00' }),
      proc(5, { elapsed: '10:00:00' }),
    ]);
    expect(findWarnings([s], limits)).toEqual([expect.objectContaining({ kind: 'idle-server', pid: 2, message: expect.stringContaining(':5173') })]);
  });

  it('never flags the shell itself, and reports a server up for days in days', () => {
    expect(findWarnings([session('x', [proc(1, { ports: [22], elapsed: '9-00:00:00' })])], limits)).toEqual([]);
    const days = findWarnings([session('x', [proc(1), proc(2, { ports: [80], elapsed: '3-01:00:00' })])], limits);
    expect(days[0].message).toContain('3d');
  });

  it('reports nothing for a quiet system', () => {
    expect(findWarnings([session('a', [proc(1)])], limits)).toEqual([]);
    expect(findWarnings([], limits)).toEqual([]);
  });
});
