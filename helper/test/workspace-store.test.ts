import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkspaceStore } from '../src/workspace-store';

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'cw-store-')), 'workspaces.json');
}

describe('WorkspaceStore', () => {
  it('creates workspaces that persist across instances', () => {
    const file = tempFile();
    const created = new WorkspaceStore(file).create({ name: 'PROJ-1', ticket: 'PROJ-1', cwd: '/tmp', url: 'https://jira/PROJ-1' });
    expect(created.id).toMatch(/^ws-[0-9a-f]{8}$/);

    const reloaded = new WorkspaceStore(file).get(created.id);
    expect(reloaded).toMatchObject({ name: 'PROJ-1', ticket: 'PROJ-1', cwd: '/tmp', url: 'https://jira/PROJ-1', windowId: null, lastTabUrls: [] });
  });

  it('starts empty when the file does not exist', () => {
    expect(new WorkspaceStore(tempFile()).list()).toEqual([]);
  });

  it('refuses to load a corrupt file rather than overwrite it', () => {
    const file = tempFile();
    writeFileSync(file, '{ not json');
    expect(() => new WorkspaceStore(file)).toThrow(file);
  });

  it('lets workspaces share a window, each with its own tab group', () => {
    const store = new WorkspaceStore(tempFile());
    const a = store.create({ name: 'a', cwd: '/tmp' });
    const b = store.create({ name: 'b', cwd: '/tmp' });
    const c = store.create({ name: 'c', cwd: '/tmp' });
    store.pairWindow(a.id, 7);
    store.pairWindow(b.id, 7, 100);
    store.pairWindow(c.id, 7, 101);
    expect(store.list().map((x) => [x.name, x.windowId, x.groupId])).toEqual([
      ['a', 7, null],
      ['b', 7, 100],
      ['c', 7, 101],
    ]);

    store.setTabs(7, ['own']);
    store.setTabs(7, ['g1'], 100);
    store.setTabs(7, ['g2'], 101);
    expect(store.list().map((x) => x.lastTabUrls)).toEqual([['own'], ['g1'], ['g2']]);

    store.pairWindow(c.id, 7, 100);
    expect(store.list().map((x) => x.groupId)).toEqual([null, null, 100]);
  });

  it('keeps the window when a group closes, and frees every workspace when the window closes', () => {
    const store = new WorkspaceStore(tempFile());
    const a = store.create({ name: 'a', cwd: '/tmp' });
    const b = store.create({ name: 'b', cwd: '/tmp' });
    store.pairWindow(a.id, 7, 100);
    store.pairWindow(b.id, 7, 101);
    store.setTabs(7, ['g1'], 100);
    store.unpairGroup(100);
    expect(store.get(a.id)).toMatchObject({ windowId: 7, groupId: null, lastTabUrls: ['g1'] });
    store.unpairWindow(7);
    expect(store.list().map((x) => [x.windowId, x.groupId])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(store.get(a.id)?.lastTabUrls).toEqual(['g1']);
  });

  it('replaces the previous window when a workspace claims a new one', () => {
    const store = new WorkspaceStore(tempFile());
    const a = store.create({ name: 'a', cwd: '/tmp' });
    store.pairWindow(a.id, 7);
    store.pairWindow(a.id, 8);
    expect(store.findByWindow(7)).toBeUndefined();
    expect(store.findByWindow(8)?.id).toBe(a.id);
  });

  it('records tabs only for the workspace paired to that window', () => {
    const store = new WorkspaceStore(tempFile());
    const a = store.create({ name: 'a', cwd: '/tmp' });
    const b = store.create({ name: 'b', cwd: '/tmp' });
    store.pairWindow(a.id, 7);
    store.setTabs(7, ['u1', 'u2']);
    store.setTabs(99, ['ignored']);
    expect(store.get(a.id)?.lastTabUrls).toEqual(['u1', 'u2']);
    expect(store.get(b.id)?.lastTabUrls).toEqual([]);
  });

  it('keeps remembered tabs when a window is unpaired', () => {
    const store = new WorkspaceStore(tempFile());
    const a = store.create({ name: 'a', cwd: '/tmp' });
    store.pairWindow(a.id, 7);
    store.setTabs(7, ['u1']);
    store.unpairWindow(7);
    expect(store.get(a.id)).toMatchObject({ windowId: null, lastTabUrls: ['u1'] });
  });

  it('sets the whole order at once, and refuses a list that is not exactly the workspaces', () => {
    const file = tempFile();
    const store = new WorkspaceStore(file);
    const [a, b, c] = ['a', 'b', 'c'].map((name) => store.create({ name, cwd: '/tmp' }));
    let changes = 0;
    store.onChange(() => changes++);

    expect(store.reorder([c.id, a.id, b.id])).toBe(true);
    expect(store.list().map((w) => w.name)).toEqual(['c', 'a', 'b']);
    expect(new WorkspaceStore(file).list().map((w) => w.name)).toEqual(['c', 'a', 'b']);
    expect(changes).toBe(1);

    expect(store.reorder([c.id, a.id, b.id])).toBe(true);
    expect(changes).toBe(1);
    for (const bad of [
      [a.id, b.id],
      [a.id, a.id, b.id],
      [a.id, b.id, 'ws-ffffffff'],
      [a.id, b.id, c.id, c.id],
    ])
      expect(store.reorder(bad)).toBe(false);
    expect(store.list().map((w) => w.name)).toEqual(['c', 'a', 'b']);
  });

  it('pins to the end of the pinned block at the top, and unpins to just below it', () => {
    const store = new WorkspaceStore(tempFile());
    const [_a, b, c, d] = ['a', 'b', 'c', 'd'].map((name) => store.create({ name, cwd: '/tmp' }));
    const names = () =>
      store
        .list()
        .map((w) => w.name)
        .join('');
    store.mark(c.id, { pinned: true });
    expect(names()).toBe('cabd');
    store.mark(d.id, { pinned: true });
    expect(names()).toBe('cdab');
    store.mark(c.id, { pinned: false });
    expect(names()).toBe('dcab');
    expect(store.get(d.id)?.pinned).toBe(true);
    expect(store.get(c.id)?.pinned).toBe(false);
    // Marking again with the same value does not move it.
    store.mark(d.id, { pinned: true });
    expect(names()).toBe('dcab');
    expect(b.name).toBe('b');
  });

  it('colors a workspace, remembers it, and loads older files without a color', () => {
    const file = tempFile();
    const store = new WorkspaceStore(file);
    const a = store.create({ name: 'a', cwd: '/tmp' });
    store.mark(a.id, { color: 'purple' });
    expect(new WorkspaceStore(file).get(a.id)).toMatchObject({ color: 'purple', pinned: false });
    store.mark(a.id, { color: null });
    expect(store.get(a.id)).toMatchObject({ color: null });

    const legacy = tempFile();
    writeFileSync(
      legacy,
      JSON.stringify({
        workspaces: [
          { id: 'ws-00000001', name: 'old', ticket: null, cwd: '/tmp', url: null, windowId: null, lastTabUrls: [], createdAt: '2026-01-01T00:00:00Z' },
        ],
      }),
    );
    expect(new WorkspaceStore(legacy).list()[0]).toMatchObject({ pinned: false, color: null });
  });

  it('hands workspaces an older version archived over to be kept, and drops them from the list', () => {
    const file = tempFile();
    const base = { ticket: null, cwd: '/tmp', url: null, windowId: null, lastTabUrls: [], createdAt: '2026-01-01T00:00:00Z' };
    writeFileSync(
      file,
      JSON.stringify({
        workspaces: [
          { ...base, id: 'ws-00000001', name: 'live' },
          { ...base, id: 'ws-00000002', name: 'shelved', archived: true },
        ],
      }),
    );
    const store = new WorkspaceStore(file);
    expect(store.list().map((w) => w.name)).toEqual(['live']);
    const kept: string[] = [];
    store.moveArchived((w) => kept.push(w.name));
    expect(kept).toEqual(['shelved']);
    expect(new WorkspaceStore(file).list().map((w) => w.name)).toEqual(['live']);
    // Once handed over, nothing is left to hand over.
    store.moveArchived((w) => kept.push(w.name));
    expect(kept).toEqual(['shelved']);
  });

  it('finds workspaces by ticket case-insensitively', () => {
    const store = new WorkspaceStore(tempFile());
    const a = store.create({ name: 'PROJ-1', ticket: 'PROJ-1', cwd: '/tmp' });
    expect(store.findByTicket('proj-1')?.id).toBe(a.id);
    expect(store.findByTicket('PROJ-2')).toBeUndefined();
  });

  it('renames a workspace, keeping its ticket', () => {
    const file = tempFile();
    const store = new WorkspaceStore(file);
    const a = store.create({ name: 'PROJ-1', ticket: 'PROJ-1', cwd: '/tmp' });
    store.rename(a.id, 'Checkout bug');
    expect(new WorkspaceStore(file).get(a.id)).toMatchObject({ name: 'Checkout bug', ticket: 'PROJ-1' });
    expect(store.findByTicket('PROJ-1')?.id).toBe(a.id);
  });

  it('refuses to rename an unknown workspace', () => {
    expect(() => new WorkspaceStore(tempFile()).rename('ws-00000000', 'x')).toThrow(/unknown workspace/);
  });

  it('moves a workspace within the list, persisting the order', () => {
    const file = tempFile();
    const store = new WorkspaceStore(file);
    const [a, b, c] = ['a', 'b', 'c'].map((name) => store.create({ name, cwd: '/tmp' }));
    store.move(a.id, 2);
    expect(new WorkspaceStore(file).list().map((w) => w.id)).toEqual([b.id, c.id, a.id]);
    store.move(a.id, 0);
    expect(store.list().map((w) => w.id)).toEqual([a.id, b.id, c.id]);
    store.move(b.id, 99);
    expect(store.list().map((w) => w.id)).toEqual([a.id, c.id, b.id]);
    expect(() => store.move('ws-00000000', 0)).toThrow(/unknown workspace/);
  });

  it('removes workspaces', () => {
    const file = tempFile();
    const store = new WorkspaceStore(file);
    const a = store.create({ name: 'a', cwd: '/tmp' });
    store.remove(a.id);
    expect(new WorkspaceStore(file).list()).toEqual([]);
  });

  it('records the PR and prompt a workspace was created with, defaulting to null', () => {
    const file = tempFile();
    const store = new WorkspaceStore(file);
    const a = store.create({ name: 'web-app#1', cwd: '/tmp', pr: 'https://github.com/o/web-app/pull/1', prompt: 'review it' });
    const b = store.create({ name: 'b', cwd: '/tmp' });
    expect(new WorkspaceStore(file).get(a.id)).toMatchObject({ pr: 'https://github.com/o/web-app/pull/1', prompt: 'review it' });
    expect(store.get(b.id)).toMatchObject({ pr: null, prompt: null });
  });

  it('finds workspaces by PR url', () => {
    const store = new WorkspaceStore(tempFile());
    const a = store.create({ name: 'a', cwd: '/tmp', pr: 'https://github.com/o/r/pull/1' });
    expect(store.findByPr('https://github.com/o/r/pull/1')?.id).toBe(a.id);
    expect(store.findByPr('https://github.com/o/r/pull/2')).toBeUndefined();
  });

  it('clears a prompt once, persisting it', () => {
    const file = tempFile();
    const store = new WorkspaceStore(file);
    const a = store.create({ name: 'a', cwd: '/tmp', prompt: 'go' });
    let changes = 0;
    store.onChange(() => changes++);
    store.clearPrompt(a.id);
    store.clearPrompt(a.id);
    expect(new WorkspaceStore(file).get(a.id)?.prompt).toBeNull();
    expect(changes).toBe(1);
  });

  it('loads workspaces saved before pr and prompt existed', () => {
    const file = tempFile();
    const old = { id: 'ws-00000001', name: 'a', ticket: null, cwd: '/tmp', url: null, windowId: null, lastTabUrls: [], createdAt: '2026-01-01T00:00:00Z' };
    writeFileSync(file, JSON.stringify({ workspaces: [old] }));
    expect(new WorkspaceStore(file).get('ws-00000001')).toMatchObject({ pr: null, prompt: null });
  });

  it('notifies listeners after each change', () => {
    const store = new WorkspaceStore(tempFile());
    let changes = 0;
    store.onChange(() => changes++);
    const a = store.create({ name: 'a', cwd: '/tmp' });
    store.pairWindow(a.id, 7);
    expect(changes).toBe(2);
  });
});
