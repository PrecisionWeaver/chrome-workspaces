import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../shared/protocol';
import { listFollowingTabs, listGroupOrder, nextGroupMove } from '../../shared/tab-order';

const ws = (id: string, windowId: number | null, groupId: number | null = null): Workspace => ({
  id, name: id, ticket: null, cwd: '/tmp', url: null, windowId, groupId, resume: null, pinned: false, archived: false, color: null, model: null, lastTabUrls: [], pr: null, prompt: null, createdAt: '2026-01-01T00:00:00Z',
});

describe('listGroupOrder', () => {
  it('lists a window\'s groups in panel order, leaving out workspaces without one or in another window', () => {
    const list = [ws('a', 1, 10), ws('x', 1), ws('b', 2, 20), ws('c', 1, 30)];
    expect(listGroupOrder(list, 1)).toEqual([10, 30]);
    expect(listGroupOrder(list, 2)).toEqual([20]);
  });
});

describe('listFollowingTabs', () => {
  it('reorders only the slots the window\'s workspaces occupy, keeping everything else in place', () => {
    const list = [ws('a', 1, 10), ws('other', 2, 99), ws('b', 1, 20), ws('plain', 1), ws('c', 1, 30)];
    // The user dragged group 30 to the front of the tab strip.
    expect(listFollowingTabs(list, 1, [30, 10, 20])).toEqual(['c', 'other', 'a', 'plain', 'b']);
  });

  it('ignores groups that belong to no workspace, such as the ones Claude in Chrome makes', () => {
    const list = [ws('a', 1, 10), ws('b', 1, 20)];
    expect(listFollowingTabs(list, 1, [555, 20, 777, 10])).toEqual(['b', 'a']);
  });

  it('is null when the order already matches, with fewer than two groups, or when a group is not in the strip', () => {
    const list = [ws('a', 1, 10), ws('b', 1, 20)];
    expect(listFollowingTabs(list, 1, [10, 20])).toBeNull();
    expect(listFollowingTabs([ws('a', 1, 10)], 1, [10])).toBeNull();
    expect(listFollowingTabs(list, 1, [20])).toBeNull();
  });
});

describe('nextGroupMove', () => {
  it('moves the group that belongs first in front of the one in its place', () => {
    expect(nextGroupMove([10, 20, 30], [30, 10, 20])).toEqual({ groupId: 30, before: 10 });
  });

  it('only considers the workspaces\' groups, so other groups in the strip are left alone', () => {
    expect(nextGroupMove([555, 20, 777, 10], [10, 20])).toEqual({ groupId: 10, before: 20 });
  });

  it('is null once in order, and cannot move a group that is not in the strip', () => {
    expect(nextGroupMove([555, 10, 20], [10, 20])).toBeNull();
    expect(nextGroupMove([10], [10, 99])).toBeNull();
  });

  it('reaches the wanted order by applying its moves repeatedly', () => {
    const desired = [4, 2, 5, 1, 3];
    let strip = [1, 2, 3, 4, 5];
    for (let steps = 0; steps < 10; steps++) {
      const move = nextGroupMove(strip, desired);
      if (!move) break;
      strip = strip.filter((id) => id !== move.groupId);
      strip.splice(strip.indexOf(move.before), 0, move.groupId);
    }
    expect(strip).toEqual(desired);
  });
});
