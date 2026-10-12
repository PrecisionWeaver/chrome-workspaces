import { describe, expect, it } from 'vitest';
import { nextIndex, resolveTheme } from '../../shared/keynav';

describe('nextIndex', () => {
  it('moves down and up, stopping at the ends', () => {
    expect([nextIndex('ArrowDown', 0, 3), nextIndex('ArrowDown', 2, 3), nextIndex('ArrowUp', 2, 3), nextIndex('ArrowUp', 0, 3)]).toEqual([1, 2, 1, 0]);
  });

  it('starts from the first row going down and the last going up when nothing has focus', () => {
    expect([nextIndex('ArrowDown', -1, 4), nextIndex('ArrowUp', -1, 4)]).toEqual([0, 3]);
  });

  it('jumps to the ends, accepts j and k, and ignores other keys and an empty list', () => {
    expect([nextIndex('Home', 2, 5), nextIndex('End', 1, 5), nextIndex('j', 0, 5), nextIndex('k', 3, 5)]).toEqual([0, 4, 1, 2]);
    expect(nextIndex('Enter', 1, 5)).toBeNull();
    expect(nextIndex('a', 1, 5)).toBeNull();
    expect(nextIndex('ArrowDown', 0, 0)).toBeNull();
  });
});

describe('resolveTheme', () => {
  it('follows the system for system, and is itself otherwise', () => {
    expect([resolveTheme('system', true), resolveTheme('system', false), resolveTheme('dark', false), resolveTheme('light', true)]).toEqual([
      'dark',
      'light',
      'dark',
      'light',
    ]);
  });
});
