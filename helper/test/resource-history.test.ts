import { describe, expect, it } from 'vitest';
import { ResourceHistory, SAMPLE_COUNT } from '../src/resource-history';

describe('ResourceHistory', () => {
  it('keeps the newest samples, oldest first, and no more than two hours of them', () => {
    const history = new ResourceHistory();
    for (let t = 0; t < SAMPLE_COUNT + 5; t++) history.record('ws-a', { t, rssKb: t * 10, cpu: 0 });
    const kept = history.get('ws-a');
    expect(kept).toHaveLength(SAMPLE_COUNT);
    expect(kept[0].t).toBe(5);
    expect(kept.at(-1)!.t).toBe(SAMPLE_COUNT + 4);
  });

  it('gives a copy, and nothing for a session it has not seen', () => {
    const history = new ResourceHistory();
    history.record('ws-a', { t: 1, rssKb: 1, cpu: 0 });
    history.get('ws-a').pop();
    expect(history.get('ws-a')).toHaveLength(1);
    expect(history.get('ws-b')).toEqual([]);
  });

  it('forgets a session that has stopped, so a restart begins a fresh trend', () => {
    const history = new ResourceHistory();
    history.record('ws-a', { t: 1, rssKb: 1, cpu: 0 });
    history.record('ws-b', { t: 1, rssKb: 1, cpu: 0 });
    history.keepOnly(['ws-b']);
    expect(history.get('ws-a')).toEqual([]);
    expect(history.get('ws-b')).toHaveLength(1);
  });
});
