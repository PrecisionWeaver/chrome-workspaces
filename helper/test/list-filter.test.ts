import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../shared/protocol';
import { filterList, workspaceMatches } from '../../shared/list-filter';

const ws = (id: string, name: string, extra: Partial<Workspace> = {}): Workspace => ({
  id,
  name,
  ticket: null,
  cwd: '/code/web-app',
  url: null,
  windowId: null,
  groupId: null,
  resume: null,
  pinned: false,
  color: null,
  model: null,
  lastTabUrls: [],
  pr: null,
  prompt: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...extra,
});

describe('workspaceMatches', () => {
  it('needs every word in the name, ticket, directory or status', () => {
    const w = ws('a', 'Email table', { ticket: 'PROJ-12' });
    expect(workspaceMatches(w, 'working', 'email proj-12')).toBe(true);
    expect(workspaceMatches(w, 'working', 'web-app busy')).toBe(true);
    expect(workspaceMatches(w, 'needs_input', 'waiting')).toBe(true);
    expect(workspaceMatches(w, 'idle', 'email working')).toBe(false);
    expect(workspaceMatches(w, undefined, '   ')).toBe(true);
  });
});

describe('filterList', () => {
  const list = [ws('a', 'Alpha'), ws('b', 'Beta'), ws('c', 'Gamma')];

  it('numbers the workspaces in list order', () => {
    expect(filterList(list, {}, '').map((x) => [x.ws.name, x.number])).toEqual([
      ['Alpha', 1],
      ['Beta', 2],
      ['Gamma', 3],
    ]);
  });

  it("keeps a workspace's number while the filter hides the ones before it", () => {
    expect(filterList(list, {}, 'gamma').map((x) => [x.ws.name, x.number])).toEqual([['Gamma', 3]]);
  });
});
