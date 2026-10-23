// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { columnCountFor, keysOf, layoutCards, layoutFromKeys } from '../src/settings-layout';

const card = (key: string) => {
  const node = document.createElement('section');
  node.dataset.key = key;
  return node;
};
const keys = (nodes: HTMLElement[]) => nodes.map((n) => n.dataset.key);

const KEYS = ['Getting started', 'Needs attention', 'Plan usage', 'Usage', 'Preferences', 'Workspace sessions', 'Updates', 'Helper', 'Housekeeping'];

describe('columnCountFor', () => {
  it('fits as many 340px columns as the width allows, from one to three', () => {
    expect([0, 339, 691, 692, 1043, 1044, 3000].map(columnCountFor)).toEqual([1, 1, 1, 2, 2, 3, 3]);
  });
});

describe('layoutCards', () => {
  it('keeps their order in one column, setup and warnings included', () => {
    const { top, columns } = layoutCards(KEYS.map(card), 1);
    expect(top).toEqual([]);
    expect(columns.map(keys)).toEqual([KEYS]);
  });

  it('puts what needs attention across the top and leads with Usage and the workspace sessions', () => {
    const { top, columns } = layoutCards(KEYS.map(card), 2);
    expect(keys(top)).toEqual(['Getting started', 'Needs attention']);
    expect(columns.map(keys)).toEqual([
      ['Usage', 'Plan usage', 'Updates', 'Housekeeping'],
      ['Workspace sessions', 'Preferences', 'Helper'],
    ]);
  });

  it('gives Plan usage the third column in three, and stays the same whatever the heights', () => {
    const { columns } = layoutCards(KEYS.map(card), 3);
    expect(columns.map((c) => c[0].dataset.key)).toEqual(['Usage', 'Workspace sessions', 'Plan usage']);
    expect(columns.flat()).toHaveLength(7);
  });

  it('copes with cards being absent', () => {
    const { top, columns } = layoutCards(['Plan usage', 'Preferences'].map(card), 3);
    expect(top).toEqual([]);
    expect(columns.map(keys)).toEqual([['Plan usage'], ['Preferences'], []]);
  });

  it('evens the columns out by height, with Usage, the sessions and the third card still leading', () => {
    const heights: Record<string, number> = {
      Usage: 400,
      'Workspace sessions': 700,
      'Plan usage': 150,
      Preferences: 200,
      Updates: 100,
      Helper: 120,
      Housekeeping: 180,
      Configuration: 500,
      Diagnostics: 160,
    };
    const cards = [...Object.keys(heights)].map(card);
    const { columns } = layoutCards(cards, 3, (c) => heights[c.dataset.key!]);
    expect(columns.map((c) => c[0].dataset.key)).toEqual(['Usage', 'Workspace sessions', 'Plan usage']);
    const totals = columns.map((c) => c.reduce((sum, n) => sum + heights[n.dataset.key!], 0));
    // Dealt in turn the middle column would be 1300 against 780 and 430; by height, none strays far from the mean.
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThan(100);
    // Each column is back in display order, so Configuration sits below the cards that come before it.
    expect(columns.flat().map((n) => n.dataset.key)).toEqual(expect.arrayContaining(Object.keys(heights)));
    for (const c of columns)
      expect(c.map((n) => Object.keys(heights).indexOf(n.dataset.key!))).toEqual(
        [...c.map((n) => Object.keys(heights).indexOf(n.dataset.key!))].sort((x, y) => x - y),
      );
    expect(columns.flat()).toHaveLength(9);
  });

  it('puts the cards of a later refresh where an earlier layout put them', () => {
    const first = layoutCards(KEYS.map(card), 3, () => 10);
    const again = layoutFromKeys(KEYS.map(card), keysOf(first));
    expect(again.columns.map(keys)).toEqual(first.columns.map(keys));
    expect(keys(again.top)).toEqual(['Getting started', 'Needs attention']);
  });
});
