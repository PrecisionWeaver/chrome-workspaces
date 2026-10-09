import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../shared/protocol';
import { splitList, workspaceMatches } from '../../shared/list-filter';

const ws = (id: string, name: string, extra: Partial<Workspace> = {}): Workspace => ({
  id, name, ticket: null, cwd: '/code/web-app', url: null, windowId: null, groupId: null, resume: null, pinned: false, archived: false, color: null, model: null, lastTabUrls: [], pr: null, prompt: null, createdAt: '2026-01-01T00:00:00Z', ...extra,
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

describe('splitList', () => {
  const list = [ws('a', 'Alpha'), ws('b', 'Beta', { archived: true }), ws('c', 'Gamma'), ws('d', 'Delta', { archived: true })];

  it('keeps archived workspaces apart and numbers the rest in list order', () => {
    const { active, archived } = splitList(list, {}, '');
    expect(active.map((x) => [x.ws.name, x.number])).toEqual([['Alpha', 1], ['Gamma', 2]]);
    expect(archived.map((x) => x.name)).toEqual(['Beta', 'Delta']);
  });

  it('keeps a workspace\'s number while a filter hides the ones before it', () => {
    const { active, archived } = splitList(list, {}, 'gamma');
    expect(active.map((x) => [x.ws.name, x.number])).toEqual([['Gamma', 2]]);
    expect(archived).toEqual([]);
    expect(splitList(list, {}, 'delta').archived.map((x) => x.name)).toEqual(['Delta']);
  });
});
