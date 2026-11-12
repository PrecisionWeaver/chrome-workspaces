import { describe, expect, it } from 'vitest';
import type { ResourceSample } from '../../shared/protocol';
import { combineHistory } from '../../shared/resources';
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
