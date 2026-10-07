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
    const created = new WorkspaceStore(file).create({ name: 'ORC-1', ticket: 'ORC-1', cwd: '/tmp', url: 'https://jira/ORC-1' });
    expect(created.id).toMatch(/^ws-[0-9a-f]{8}$/);

    const reloaded = new WorkspaceStore(file).get(created.id);
    expect(reloaded).toMatchObject({ name: 'ORC-1', ticket: 'ORC-1', cwd: '/tmp', url: 'https://jira/ORC-1', windowId: null, lastTabUrls: [] });
  });

  it('starts empty when the file does not exist', () => {
    expect(new WorkspaceStore(tempFile()).list()).toEqual([]);
  });

  it('refuses to load a corrupt file rather than overwrite it', () => {
    const file = tempFile();
    writeFileSync(file, '{ not json');
    expect(() => new WorkspaceStore(file)).toThrow(file);
  });

  it('moves a window to the workspace that pairs with it', () => {
    const store = new WorkspaceStore(tempFile());
    const a = store.create({ name: 'a', cwd: '/tmp' });
    const b = store.create({ name: 'b', cwd: '/tmp' });
    store.pairWindow(a.id, 7);
    store.pairWindow(b.id, 7);
    expect(store.get(a.id)?.windowId).toBeNull();
    expect(store.get(b.id)?.windowId).toBe(7);
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

  it('finds workspaces by ticket case-insensitively', () => {
    const store = new WorkspaceStore(tempFile());
    const a = store.create({ name: 'ORC-1', ticket: 'ORC-1', cwd: '/tmp' });
    expect(store.findByTicket('orc-1')?.id).toBe(a.id);
    expect(store.findByTicket('ORC-2')).toBeUndefined();
  });

  it('renames a workspace, keeping its ticket', () => {
    const file = tempFile();
    const store = new WorkspaceStore(file);
    const a = store.create({ name: 'ORC-1', ticket: 'ORC-1', cwd: '/tmp' });
    store.rename(a.id, 'Checkout bug');
    expect(new WorkspaceStore(file).get(a.id)).toMatchObject({ name: 'Checkout bug', ticket: 'ORC-1' });
    expect(store.findByTicket('ORC-1')?.id).toBe(a.id);
  });

  it('refuses to rename an unknown workspace', () => {
    expect(() => new WorkspaceStore(tempFile()).rename('ws-00000000', 'x')).toThrow(/unknown workspace/);
  });

  it('removes workspaces', () => {
    const file = tempFile();
    const store = new WorkspaceStore(file);
    const a = store.create({ name: 'a', cwd: '/tmp' });
    store.remove(a.id);
    expect(new WorkspaceStore(file).list()).toEqual([]);
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
