import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALL_WINDOW_MS } from '../../shared/claude-groups';
import { installChrome } from './chrome-mock';
import { makeWorkspace } from './fixtures';

let fake: ReturnType<typeof installChrome>;

/** The module keeps its queue in module state, so each test gets a fresh copy. */
async function load(workspaces = [makeWorkspace({ id: 'ws-a', windowId: 1 })]) {
  vi.resetModules();
  const { placeClaudeGroups } = await import('../src/claude-groups');
  return placeClaudeGroups(() => workspaces);
}
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  fake = installChrome();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A window with a "Claude" group in it, as Claude in Chrome would open. */
function claudeGroup(windowId: number, title = '⏳ Claude') {
  const tab = fake.addTab(windowId, 'https://example.com/');
  const id = fake.addGroup([tab.id], { title });
  return { id, group: fake.group(id)! };
}

describe('placeClaudeGroups', () => {
  it('moves a new Claude group into the window of the workspace whose browser call finished just after', async () => {
    const { windowId } = fake.addWindow();
    const { windowId: stray } = fake.addWindow();
    const call = await load([makeWorkspace({ id: 'ws-a', windowId })]);
    const { id, group } = claudeGroup(stray);

    fake.events.tabGroups.onCreated.emit(group);
    call({ workspaceId: 'ws-a', at: Date.now() + 100 });
    await flush();

    expect(fake.group(id)?.windowId).toBe(windowId);
  });

  it('places a group that arrives after the call, within the slack the hook allows', async () => {
    const { windowId } = fake.addWindow();
    const { windowId: stray } = fake.addWindow();
    const call = await load([makeWorkspace({ id: 'ws-a', windowId })]);
    const { id, group } = claudeGroup(stray);

    call({ workspaceId: 'ws-a', at: Date.now() - 200 });
    fake.events.tabGroups.onUpdated.emit(group);
    await flush();

    expect(fake.group(id)?.windowId).toBe(windowId);
  });

  it('leaves groups that are not titled Claude alone', async () => {
    const { windowId } = fake.addWindow();
    const { windowId: stray } = fake.addWindow();
    const call = await load([makeWorkspace({ id: 'ws-a', windowId })]);
    const { id, group } = claudeGroup(stray, 'Research');

    fake.events.tabGroups.onCreated.emit(group);
    call({ workspaceId: 'ws-a', at: Date.now() });
    await flush();

    expect(fake.group(id)?.windowId).toBe(stray);
  });

  it('moves a group only once, so one the user later drags elsewhere stays put', async () => {
    const { windowId } = fake.addWindow();
    const { windowId: stray } = fake.addWindow();
    const call = await load([makeWorkspace({ id: 'ws-a', windowId })]);
    const { id, group } = claudeGroup(stray);

    fake.events.tabGroups.onCreated.emit(group);
    call({ workspaceId: 'ws-a', at: Date.now() });
    await flush();
    await fake.mock.tabGroups.move(id, { windowId: stray, index: -1 });
    fake.events.tabGroups.onUpdated.emit(group);
    call({ workspaceId: 'ws-a', at: Date.now() });
    await flush();

    expect(fake.group(id)?.windowId).toBe(stray);
  });

  it('gives up on a group that no call claims within the window', async () => {
    const { windowId } = fake.addWindow();
    const { windowId: stray } = fake.addWindow();
    const call = await load([makeWorkspace({ id: 'ws-a', windowId })]);
    const { id, group } = claudeGroup(stray);

    fake.events.tabGroups.onCreated.emit(group);
    vi.setSystemTime(Date.now() + CALL_WINDOW_MS + 1000);
    call({ workspaceId: 'ws-a', at: Date.now() });
    await flush();
    // A late call finds nothing waiting.
    call({ workspaceId: 'ws-a', at: Date.now() });
    await flush();

    expect(fake.group(id)?.windowId).toBe(stray);
  });

  it('does not move a group when its workspace has no window', async () => {
    const { windowId: stray } = fake.addWindow();
    const call = await load([makeWorkspace({ id: 'ws-a', windowId: null })]);
    const { id, group } = claudeGroup(stray);

    fake.events.tabGroups.onCreated.emit(group);
    call({ workspaceId: 'ws-a', at: Date.now() });
    await flush();

    expect(fake.group(id)?.windowId).toBe(stray);
    expect(fake.mock.tabGroups.move).not.toHaveBeenCalled();
  });

  it('survives a group that closed before it could be moved', async () => {
    const { windowId } = fake.addWindow();
    const { windowId: stray } = fake.addWindow();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const call = await load([makeWorkspace({ id: 'ws-a', windowId })]);
    const { id, group } = claudeGroup(stray);

    fake.events.tabGroups.onCreated.emit(group);
    fake.removeGroup(id);
    call({ workspaceId: 'ws-a', at: Date.now() });
    await flush();

    expect(warn).toHaveBeenCalledWith('could not move Claude tab group', expect.any(Error));
  });

  it('stops waiting for a group once it is removed, and treats the same id as new if it returns', async () => {
    const { windowId } = fake.addWindow();
    const { windowId: stray } = fake.addWindow();
    const call = await load([makeWorkspace({ id: 'ws-a', windowId })]);
    const { id, group } = claudeGroup(stray);

    fake.events.tabGroups.onCreated.emit(group);
    fake.events.tabGroups.onRemoved.emit(group);
    call({ workspaceId: 'ws-a', at: Date.now() });
    await flush();
    expect(fake.group(id)?.windowId).toBe(stray);

    fake.events.tabGroups.onCreated.emit(group);
    call({ workspaceId: 'ws-a', at: Date.now() });
    await flush();
    expect(fake.group(id)?.windowId).toBe(windowId);
  });
});
