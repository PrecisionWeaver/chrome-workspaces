import { describe, expect, it } from 'vitest';
import { matchGroups, matchWindows } from '../../shared/pairing';
import type { Workspace } from '../../shared/protocol';

function ws(id: string, lastTabUrls: string[], windowId: number | null = null): Workspace {
  return {
    id,
    name: id,
    ticket: null,
    cwd: '/tmp',
    url: null,
    windowId,
    groupId: null,
    resume: null,
    pinned: false,
    archived: false,
    color: null,
    model: null,
    lastTabUrls,
    pr: null,
    prompt: null,
    createdAt: '2026-01-01T00:00:00Z',
  };
}

describe('matchWindows', () => {
  it('pairs a workspace with the window holding the same tabs', () => {
    const result = matchWindows([ws('a', ['https://x/1', 'https://x/2'])], [{ id: 7, urls: ['https://x/2', 'https://x/1'] }]);
    expect(result).toEqual([{ workspaceId: 'a', windowId: 7 }]);
  });

  it('pairs on partial overlap at or above the threshold', () => {
    const result = matchWindows([ws('a', ['u1', 'u2', 'u3'])], [{ id: 7, urls: ['u1', 'u2', 'u3', 'u4'] }]);
    expect(result).toEqual([{ workspaceId: 'a', windowId: 7 }]);
  });

  it('does not pair below the threshold', () => {
    expect(matchWindows([ws('a', ['u1', 'u2', 'u3'])], [{ id: 7, urls: ['u1', 'v2', 'v3'] }])).toEqual([]);
  });

  it('never takes a window another workspace is paired to', () => {
    const workspaces = [ws('a', ['u1']), ws('b', ['u1'], 7)];
    expect(matchWindows(workspaces, [{ id: 7, urls: ['u1'] }])).toEqual([]);
  });

  it('gives a contested window to the closer match', () => {
    const workspaces = [ws('a', ['u1', 'u2', 'u9']), ws('b', ['u1', 'u2'])];
    expect(matchWindows(workspaces, [{ id: 7, urls: ['u1', 'u2'] }])).toEqual([{ workspaceId: 'b', windowId: 7 }]);
  });

  it('leaves alone workspaces whose window is still open', () => {
    expect(
      matchWindows(
        [ws('a', ['u1'], 7)],
        [
          { id: 7, urls: ['u1'] },
          { id: 8, urls: ['u1'] },
        ],
      ),
    ).toEqual([]);
  });

  it('re-pairs a workspace whose remembered window no longer exists', () => {
    expect(matchWindows([ws('a', ['u1'], 99)], [{ id: 8, urls: ['u1'] }])).toEqual([{ workspaceId: 'a', windowId: 8 }]);
  });

  it('ignores workspaces with no remembered tabs', () => {
    expect(matchWindows([ws('a', [])], [{ id: 8, urls: [] }])).toEqual([]);
  });
});

describe('matchGroups', () => {
  it('pairs a workspace that lost its window with the tab group holding its tabs', () => {
    expect(matchGroups([ws('a', ['u1', 'u2'])], [{ id: 5, windowId: 3, urls: ['u2', 'u1'] }])).toEqual([{ workspaceId: 'a', windowId: 3, groupId: 5 }]);
  });

  it('leaves workspaces that still have a window, and groups already paired, alone', () => {
    expect(matchGroups([ws('a', ['u1'], 7)], [{ id: 5, windowId: 3, urls: ['u1'] }])).toEqual([]);
    const taken: Workspace = { ...ws('b', ['u1'], 3), groupId: 5 };
    expect(matchGroups([ws('a', ['u1']), taken], [{ id: 5, windowId: 3, urls: ['u1'] }])).toEqual([]);
  });

  it('gives a contested group to the closer match', () => {
    const result = matchGroups([ws('a', ['u1', 'u2', 'u9']), ws('b', ['u1', 'u2'])], [{ id: 5, windowId: 3, urls: ['u1', 'u2'] }]);
    expect(result).toEqual([{ workspaceId: 'b', windowId: 3, groupId: 5 }]);
  });
});
