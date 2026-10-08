import { describe, expect, it } from 'vitest';
import { layoutGraph } from '../../shared/git-graph';

const nodes = (rows: ReturnType<typeof layoutGraph>) => rows.map((r) => r.node);

describe('layoutGraph', () => {
  it('keeps a linear history in one column', () => {
    const rows = layoutGraph([
      { sha: 'c', parents: ['b'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ]);
    expect(nodes(rows)).toEqual([0, 0, 0]);
    expect(rows.every((r) => r.width === 1)).toBe(true);
    // The root has no line down; the first commit has none coming in.
    expect(rows[2].segments).toEqual([{ x1: 0, y1: 0, x2: 0, y2: 0.5, color: 0 }]);
    expect(rows[0].segments).toEqual([{ x1: 0, y1: 0.5, x2: 0, y2: 1, color: 0 }]);
  });

  it('opens a second column for a merge and closes it where the branches meet', () => {
    // m merges side (s) into main (b); both descend from a.
    const rows = layoutGraph([
      { sha: 'm', parents: ['b', 's'] },
      { sha: 's', parents: ['a'] },
      { sha: 'b', parents: ['a'] },
      { sha: 'a', parents: [] },
    ]);
    expect(nodes(rows)).toEqual([0, 1, 0, 1]);
    expect(rows[0].segments).toContainEqual({ x1: 0, y1: 0.5, x2: 1, y2: 1, color: 1 });
    // `b` bends over to join the side line, which carries on into `a`.
    expect(rows[2].segments).toContainEqual({ x1: 0, y1: 0.5, x2: 1, y2: 1, color: 1 });
    expect(rows[3].segments).toContainEqual({ x1: 1, y1: 0, x2: 1, y2: 0.5, color: 1 });
    expect(rows[3].width).toBe(2);
  });

  it('passes unrelated lines straight through a row', () => {
    const rows = layoutGraph([
      { sha: 'x', parents: ['r'] },
      { sha: 'y', parents: ['r'] },
      { sha: 'r', parents: [] },
    ]);
    expect(nodes(rows)).toEqual([0, 1, 0]);
    expect(rows[1].segments).toContainEqual({ x1: 0, y1: 0, x2: 0, y2: 1, color: 0 });
  });

  it('handles an empty list', () => {
    expect(layoutGraph([])).toEqual([]);
  });
});
