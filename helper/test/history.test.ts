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
    const ws0 = h.store.create({ name: 'closing', cwd: h.defaultCwd, ticket: 'PROJ-7', url: 'https://jira.example/PROJ-7', model: 'sonnet', tabs: ['https://a.example'] });
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
});
