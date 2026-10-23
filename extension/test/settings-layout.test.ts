// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { columnCountFor, layoutCards } from '../src/settings-layout';

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
});
