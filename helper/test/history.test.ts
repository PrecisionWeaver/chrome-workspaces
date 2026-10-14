import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient } from '../../shared/protocol';
import { HistoryStore, MAX_HISTORY } from '../src/history';
import { launchSpec } from '../src/launch';
import { WorkspaceStore } from '../src/workspace-store';
import { connectControl, opened, startHarness, type Harness } from './harness';
import { waitFor } from './wait-for';

const file = () => join(mkdtempSync(join(tmpdir(), 'cw-hist-')), 'history.json');
const RESUME = '169128c8-8b10-48e0-993f-a743c8fad9ef';

describe('HistoryStore', () => {
  it('remembers a removed workspace newest first, keeps it across restarts, and caps the list', () => {
    const f = file();
    const history = new HistoryStore(f);
    const store = new WorkspaceStore(join(mkdtempSync(join(tmpdir(), 'cw-hist-ws-')), 'w.json'));
    const a = store.create({ name: 'a', cwd: '/tmp', ticket: 'PROJ-1', pr: 'https://github.com/o/r/pull/1', model: 'opus' });
    history.record(a, RESUME);
    history.record(store.create({ name: 'b', cwd: '/tmp' }), null);
    expect(history.list().map((e) => e.name)).toEqual(['b', 'a']);
    expect(new HistoryStore(f).list()[1]).toMatchObject({ name: 'a', ticket: 'PROJ-1', model: 'opus', resumeId: RESUME });

    for (let i = 0; i < MAX_HISTORY + 5; i++) history.record(a, null);
    expect(history.list()).toHaveLength(MAX_HISTORY);
    history.remove(history.list()[0].id);
    expect(history.list()).toHaveLength(MAX_HISTORY - 1);
  });

  it('starts empty from a missing or damaged file instead of failing', () => {
    expect(new HistoryStore(join(tmpdir(), 'cw-no-such-history.json')).list()).toEqual([]);
    const damaged = file();
    writeFileSync(damaged, '{ not json');
    expect(new HistoryStore(damaged).list()).toEqual([]);
  });
});

describe('launch with a restored conversation', () => {
  it('resumes the session a restored workspace carries', () => {
    const store = new WorkspaceStore(join(mkdtempSync(join(tmpdir(), 'cw-hist-ws-')), 'w.json'));
    const restored = store.create({ name: 'r', cwd: '/tmp', resume: RESUME });
    expect(restored.resume).toBe(RESUME);
    expect(launchSpec(restored, { shell: '/bin/zsh', resumeId: restored.resume }).args[3]).toContain(`--resume ${RESUME}`);
  });
});

describe('remove and restore through the control channel', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('records a removed workspace with its conversation, and restoring brings it back resuming it', async () => {
    const ws0 = h.store.create({
      name: 'closing',
      cwd: h.defaultCwd,
      ticket: 'PROJ-7',
      url: 'https://jira.example/PROJ-7',
      model: 'sonnet',
      tabs: ['https://a.example'],
    });
    h.resumeIds[ws0.id] = RESUME;
    const { ws, messages } = connectControl(h);
    await opened(ws);
    const histories = () => messages.filter((m): m is Extract<ControlToClient, { type: 'history' }> => m.type === 'history');
    await waitFor(() => histories().length >= 1);

    ws.send(JSON.stringify({ type: 'remove', id: ws0.id }));
    await waitFor(() => histories().at(-1)?.entries.length === 1);
    const entry = histories().at(-1)!.entries[0];
    expect(entry).toMatchObject({ name: 'closing', ticket: 'PROJ-7', resumeId: RESUME, model: 'sonnet', tabs: ['https://a.example'] });
    expect(h.store.list()).toHaveLength(0);

    ws.send(JSON.stringify({ type: 'restore', historyId: entry.id, windowId: null }));
    await waitFor(() => h.store.list().length === 1);
    const back = h.store.list()[0];
    expect(back).toMatchObject({ name: 'closing', ticket: 'PROJ-7', model: 'sonnet', resume: RESUME, lastTabUrls: ['https://a.example'] });
    expect(back.id).not.toBe(ws0.id);
    expect(messages.some((m) => m.type === 'open' && m.id === back.id)).toBe(true);
    // Restored once; it is no longer in history, and restoring it again does nothing.
    await waitFor(() => histories().at(-1)?.entries.length === 0);
    ws.send(JSON.stringify({ type: 'restore', historyId: entry.id, windowId: null }));
    ws.send(JSON.stringify({ type: 'forget', historyId: 'h-nothere' }));
    ws.close();
    expect(h.store.list()).toHaveLength(1);
  });

  it('restores into the default directory when the old one is gone', async () => {
    const gone = h.store.create({ name: 'moved', cwd: '/no/such/dir' });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'remove', id: gone.id }));
    await waitFor(() => messages.some((m) => m.type === 'history' && m.entries.length === 1));
    const entry = (messages.filter((m) => m.type === 'history').at(-1) as Extract<ControlToClient, { type: 'history' }>).entries[0];
    ws.send(JSON.stringify({ type: 'restore', historyId: entry.id, windowId: 5 }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0]).toMatchObject({ name: 'moved', cwd: h.defaultCwd, windowId: 5 });
    ws.close();
  });

  it('restores into a window the others share as a tab group of its own', async () => {
    const archived = h.store.create({ name: 'acme/app', cwd: h.defaultCwd, tabs: ['https://a.example'] });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'remove', id: archived.id }));
    await waitFor(() => messages.some((m) => m.type === 'history' && m.entries.length === 1));
    const entry = (messages.filter((m) => m.type === 'history').at(-1) as Extract<ControlToClient, { type: 'history' }>).entries[0];
    ws.send(JSON.stringify({ type: 'restore', historyId: entry.id, windowId: 5 }));
    await waitFor(() => h.store.list().length === 1);
    const back = h.store.list()[0];
    expect(back.windowId).toBe(5);
    await waitFor(() => messages.some((m) => m.type === 'group' && m.id === back.id));
    ws.close();
  });

  it('keeps pin and color through an archive and restore', async () => {
    const pinned = h.store.create({ name: 'pinned', cwd: h.defaultCwd });
    h.store.mark(pinned.id, { pinned: true, color: 'green' });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'remove', id: pinned.id }));
    await waitFor(() => messages.some((m) => m.type === 'history' && m.entries.length === 1));
    const entry = (messages.filter((m) => m.type === 'history').at(-1) as Extract<ControlToClient, { type: 'history' }>).entries[0];
    expect(entry).toMatchObject({ pinned: true, color: 'green' });
    ws.send(JSON.stringify({ type: 'restore', historyId: entry.id, windowId: null }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0]).toMatchObject({ pinned: true, color: 'green' });
    ws.close();
  });

  it('closes the group or window only when asked, and never a window other workspaces share', async () => {
    const grouped = h.store.create({ name: 'grouped', cwd: h.defaultCwd });
    const sibling = h.store.create({ name: 'sibling', cwd: h.defaultCwd });
    const solo = h.store.create({ name: 'solo', cwd: h.defaultCwd });
    const keep = h.store.create({ name: 'keep', cwd: h.defaultCwd });
    h.store.pairWindow(grouped.id, 1, 11);
    h.store.pairWindow(sibling.id, 1, 12);
    h.store.pairWindow(solo.id, 2);
    h.store.pairWindow(keep.id, 3);
    const { ws, messages } = connectControl(h);
    await opened(ws);
    const closes = () => messages.filter((m) => m.type === 'closeTabs');

    ws.send(JSON.stringify({ type: 'remove', id: keep.id }));
    await waitFor(() => !h.store.get(keep.id));
    ws.send(JSON.stringify({ type: 'remove', id: grouped.id, closeTabs: true }));
    await waitFor(() => closes().length === 1);
    expect(closes()[0]).toEqual({ type: 'closeTabs', windowId: 1, groupId: 11 });
    ws.send(JSON.stringify({ type: 'remove', id: solo.id, closeTabs: true }));
    await waitFor(() => closes().length === 2);
    expect(closes()[1]).toEqual({ type: 'closeTabs', windowId: 2, groupId: null });
    // The window a group shares is not closed from under its neighbours.
    expect(closes()).toHaveLength(2);
    ws.close();
  });

  it('forgets every archived workspace at once', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const b = h.store.create({ name: 'b', cwd: h.defaultCwd });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'remove', id: a.id }));
    ws.send(JSON.stringify({ type: 'remove', id: b.id }));
    await waitFor(() => messages.some((m) => m.type === 'history' && m.entries.length === 2));
    ws.send(JSON.stringify({ type: 'forgetAll' }));
    await waitFor(() => (messages.filter((m) => m.type === 'history').at(-1) as Extract<ControlToClient, { type: 'history' }>).entries.length === 0);
    ws.close();
  });
});
