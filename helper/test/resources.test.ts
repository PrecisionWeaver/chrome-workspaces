import { describe, expect, it } from 'vitest';
import type { ResourceSample } from '../../shared/protocol';
import { combineHistory, topConsumers } from '../../shared/resources';
import { makeSession } from '../../extension/test/fixtures';

const MIN = 60_000;
const sample = (minute: number, rssKb: number, cpu = 0, offsetMs = 0): ResourceSample => ({ t: 10 * MIN + minute * MIN + offsetMs, rssKb, cpu });

describe('combineHistory', () => {
  it('adds the workspaces together minute by minute, oldest first', () => {
    const a = makeSession({ history: [sample(0, 100, 1), sample(1, 200, 2)] });
    const b = makeSession({ history: [sample(0, 10, 5, 20_000), sample(1, 20, 5, 20_000)] });
    expect(combineHistory([a, b])).toEqual([
      { t: 10 * MIN, rssKb: 110, cpu: 6, sessions: 2 },
      { t: 11 * MIN, rssKb: 220, cpu: 7, sessions: 2 },
    ]);
  });

  it('moves with workspaces as they start later or stop, rather than padding them', () => {
    const early = makeSession({ history: [sample(0, 100), sample(1, 100), sample(2, 100)] });
    const late = makeSession({ history: [sample(2, 50)] });
    expect(combineHistory([early, late]).map((p) => [p.rssKb, p.sessions])).toEqual([
      [100, 1],
      [100, 1],
      [150, 2],
    ]);
  });

  it('counts a session once in a minute that holds two of its samples, using the later', () => {
    const a = makeSession({ history: [sample(0, 100, 1), sample(0, 300, 3, 30_000)] });
    expect(combineHistory([a])).toEqual([{ t: 10 * MIN, rssKb: 300, cpu: 3, sessions: 1 }]);
  });

  it('is empty when nothing has been sampled', () => {
    expect(combineHistory([])).toEqual([]);
    expect(combineHistory([makeSession({ history: [] })])).toEqual([]);
  });
});

describe('topConsumers', () => {
  const proc = (rssKb: number, cpu: number) => ({ pid: 1, ppid: 0, command: 'x', cpu, rssKb, elapsed: '00:01', ports: [] });

  it('lists running workspaces by memory now, biggest first, up to the count, leaving out stopped ones', () => {
    const sessions = [
      makeSession({ id: 'a', name: 'acme/app', processes: [proc(100, 1), proc(100, 1)] }),
      makeSession({ id: 'b', name: 'acme/api', processes: [proc(500, 2)] }),
      makeSession({ id: 'c', name: 'acme/web', pid: null, processes: [proc(9000, 9)] }),
      makeSession({ id: 'd', name: 'acme/cli', processes: [proc(50, 0)] }),
    ];
    expect(topConsumers(sessions, 2)).toEqual([
      { id: 'b', name: 'acme/api', rssKb: 500, cpu: 2 },
      { id: 'a', name: 'acme/app', rssKb: 200, cpu: 2 },
    ]);
  });
});
