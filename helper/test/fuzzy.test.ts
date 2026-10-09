import { describe, expect, it } from 'vitest';
import { fuzzyRank, fuzzyScore } from '../../shared/fuzzy';

describe('fuzzyScore', () => {
  it('matches a subsequence in order, ignoring case and spaces, and rejects anything else', () => {
    expect(fuzzyScore('nw', 'New workspace')).not.toBeNull();
    expect(fuzzyScore('NEW WS', 'New workspace')).not.toBeNull();
    expect(fuzzyScore('wn', 'New workspace')).toBeNull();
    expect(fuzzyScore('xyz', 'New workspace')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
  });

  it('prefers word starts and consecutive characters', () => {
    expect(fuzzyScore('nw', 'New workspace')!).toBeGreaterThan(fuzzyScore('nw', 'unknown rows')!);
    expect(fuzzyScore('work', 'workspace')!).toBeGreaterThan(fuzzyScore('work', 'wxoxrxk')!);
  });
});

describe('fuzzyRank', () => {
  const items = ['Draft: new window', 'New workspace', 'Settings', 'Refresh review requests'];

  it('puts the closest match first and drops non-matches', () => {
    expect(fuzzyRank('nw', items, (s) => s).map((r) => r.item)[0]).toBe('New workspace');
    expect(fuzzyRank('rrr', items, (s) => s).map((r) => r.item)).toEqual(['Refresh review requests']);
  });

  it('keeps the given order when there is no query, and for ties', () => {
    expect(fuzzyRank('', items, (s) => s).map((r) => r.item)).toEqual(items);
    expect(fuzzyRank('a', ['ab', 'ab'], (s) => s).map((r) => r.item)).toEqual(['ab', 'ab']);
  });
});
