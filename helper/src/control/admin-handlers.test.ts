import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import type { ControlToClient, ControlToHelper } from '../../../shared/protocol/protocol';
import { errorMessage } from '../../../shared/protocol/errors';
import { handleAdmin, isAdminRequest, type AdminRequest } from './admin-handlers';
import type { HubContext } from './hub';

const ws = {} as WebSocket;
const REVIEWS = { items: [], error: null, fetchedAt: null, refreshing: false };

/** A hub that records what it was asked to send, around an admin service a test fills in. */
function fakeHub(admin: Record<string, unknown>, workspaces: string[] = [], configEdit: Record<string, unknown> = {}) {
  const toAsker: ControlToClient[] = [];
  const toAll: ControlToClient[] = [];
  const pending: Promise<unknown>[] = [];
  const hub = {
    options: { admin, configEdit, reviews: { state: () => REVIEWS }, store: { get: (id: string) => (workspaces.includes(id) ? { id } : undefined) } },
    clientCount: 2,
    send: (message: ControlToClient) => toAll.push(message) > 0,
    sendTo: (_ws: WebSocket, message: ControlToClient) => void toAsker.push(message),
    answer<T>(_ws: WebSocket, work: Promise<T>, ok: (value: T) => ControlToClient, fail: (reason: string) => ControlToClient) {
      pending.push(
        work.then(
          (value) => toAsker.push(ok(value)),
          (error: unknown) => toAsker.push(fail(errorMessage(error))),
        ),
      );
    },
  } as unknown as HubContext;
  const ask = async (message: AdminRequest) => {
    handleAdmin(hub, message, ws);
    await Promise.all(pending);
  };
  return { ask, toAsker, toAll };
}

describe('isAdminRequest', () => {
  it('claims what Settings asks, and nothing else', () => {
    const types: ControlToHelper['type'][] = ['system', 'admin', 'systemLog', 'timeline', 'exportData', 'checkUpdates', 'getConfigEdit', 'saveConfigEdit'];
    for (const type of types) expect(isAdminRequest({ type } as ControlToHelper)).toBe(true);
    expect(isAdminRequest({ type: 'listRepos' })).toBe(false);
    expect(isAdminRequest({ type: 'git', id: 'ws-0123abcd' })).toBe(false);
  });
});

describe('handleAdmin', () => {
  it('answers system with a snapshot taken for the reviews and clients the hub has, or why it could not be taken', async () => {
    const asked: unknown[] = [];
    const snapshot = { helper: { pid: 1 } };
    const good = fakeHub({ snapshot: async (context: unknown) => (asked.push(context), snapshot) });
    await good.ask({ type: 'system' });
    expect(asked).toEqual([{ reviews: REVIEWS, clients: 2 }]);
    expect(good.toAsker).toEqual([{ type: 'system', snapshot, error: null }]);

    const failing = fakeHub({ snapshot: async () => Promise.reject(new Error('ps failed')) });
    await failing.ask({ type: 'system' });
    expect(failing.toAsker).toEqual([{ type: 'system', snapshot: null, error: 'ps failed' }]);
  });

  it('runs an action, tells every client which sessions it reset, and reports a failure as a result', async () => {
    const hub = fakeHub({ run: async () => ({ ok: true, message: 'Restarted.', reset: ['ws-0123abcd'] }) });
    await hub.ask({ type: 'admin', request: { action: 'restartSession', id: 'ws-0123abcd' } });
    expect(hub.toAll).toEqual([{ type: 'sessionReset', id: 'ws-0123abcd' }]);
    expect(hub.toAsker).toEqual([{ type: 'adminResult', action: 'restartSession', ok: true, message: 'Restarted.' }]);

    const quiet = fakeHub({ run: async () => ({ ok: true, message: 'Cleared.' }) });
    await quiet.ask({ type: 'admin', request: { action: 'clearLog' } });
    expect(quiet.toAll).toEqual([]);

    const failing = fakeHub({ run: async () => Promise.reject(new Error('launchctl failed')) });
    await failing.ask({ type: 'admin', request: { action: 'restartHelper' } });
    expect(failing.toAsker).toEqual([{ type: 'adminResult', action: 'restartHelper', ok: false, message: 'launchctl failed' }]);
  });

  it('sends the log and the export as the service gives them', async () => {
    const hub = fakeHub({ log: () => 'line one\n', exportData: () => '{"workspaces":[]}' });
    await hub.ask({ type: 'systemLog' });
    await hub.ask({ type: 'exportData' });
    expect(hub.toAsker).toEqual([
      { type: 'systemLog', text: 'line one\n' },
      { type: 'exportData', json: '{"workspaces":[]}' },
    ]);
  });

  it("sends a workspace's timeline, and says so for one with no session or that is not in the list", async () => {
    const events = [{ at: '2026-10-08T10:00:00Z', kind: 'said', tool: '', summary: 'done' }];
    const hub = fakeHub({ timeline: (id: string) => (id === 'ws-00000001' ? events : null) }, ['ws-00000001', 'ws-00000002']);
    await hub.ask({ type: 'timeline', id: 'ws-00000001' });
    await hub.ask({ type: 'timeline', id: 'ws-00000002' });
    await hub.ask({ type: 'timeline', id: 'ws-00000003' });
    const none = 'This workspace has no claude session yet.';
    expect(hub.toAsker).toEqual([
      { type: 'timeline', id: 'ws-00000001', events, error: null },
      { type: 'timeline', id: 'ws-00000002', events: [], error: none },
      { type: 'timeline', id: 'ws-00000003', events: [], error: none },
    ]);
  });

  it('answers an update check with the status, or why it could not check', async () => {
    const status = { behind: 2 };
    const hub = fakeHub({ checkUpdates: async () => status });
    await hub.ask({ type: 'checkUpdates' });
    expect(hub.toAsker).toEqual([{ type: 'updates', status, error: null }]);

    const failing = fakeHub({ checkUpdates: async () => Promise.reject(new Error('not a git checkout')) });
    await failing.ask({ type: 'checkUpdates' });
    expect(failing.toAsker).toEqual([{ type: 'updates', status: null, error: 'not a git checkout' }]);
  });
});

describe('handleAdmin config editor', () => {
  const edit = { values: { defaultCwd: '', defaultModel: '', claudeCommand: '', promptsFile: '' }, promptsPath: '/p.md', prompts: null };
  const values = { defaultCwd: '', defaultModel: 'opus', claudeCommand: '', promptsFile: '' };

  it('answers getConfigEdit with the fields, or why they could not be read', async () => {
    const good = fakeHub({}, [], { read: () => edit });
    await good.ask({ type: 'getConfigEdit' });
    expect(good.toAsker).toEqual([{ type: 'configEdit', edit, error: null }]);
    const bad = fakeHub({}, [], {
      read: () => {
        throw new Error('config.json is not valid JSON');
      },
    });
    await bad.ask({ type: 'getConfigEdit' });
    expect(bad.toAsker).toEqual([{ type: 'configEdit', edit: null, error: 'config.json is not valid JSON' }]);
  });

  it('saves, then answers with the outcome and the fields as they now stand', async () => {
    const saves: unknown[] = [];
    const hub = fakeHub({}, [], { read: () => edit, save: (...args: unknown[]) => (saves.push(args), { ok: true, message: 'Saved.' }) });
    await hub.ask({ type: 'saveConfigEdit', values, prompts: 'note' });
    expect(saves).toEqual([[values, 'note']]);
    expect(hub.toAsker).toEqual([{ type: 'configSaved', ok: true, message: 'Saved.', edit }]);
  });

  it('reports a refused save, and still answers when the fields cannot be read back', async () => {
    const hub = fakeHub({}, [], {
      read: () => {
        throw new Error('gone');
      },
      save: () => ({ ok: false, message: 'Default model "x" is not a model name.' }),
    });
    await hub.ask({ type: 'saveConfigEdit', values, prompts: null });
    expect(hub.toAsker).toEqual([{ type: 'configSaved', ok: false, message: 'Default model "x" is not a model name.', edit: null }]);
  });
});
