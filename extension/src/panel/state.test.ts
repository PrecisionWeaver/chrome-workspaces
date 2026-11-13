import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../../testing/chrome-mock';
import { makeWorkspace } from '../../testing/fixtures';
import { createPanelState, type PanelState } from './state';

const showOnly = vi.fn(async () => {});
vi.mock('../background/windows', () => ({ showOnly: (...args: unknown[]) => showOnly(...(args as [])) }));

let fake: ReturnType<typeof installChrome>;
let state: PanelState;
let windowId: number;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const ws = (id: string, overrides = {}) => makeWorkspace({ id, name: `acme/${id}`, windowId, ...overrides });
const selected = () => fake.storage.local.selectedByWindow as Record<string, string> | undefined;

beforeEach(() => {
  fake = installChrome();
  windowId = fake.addWindow().windowId;
  showOnly.mockClear();
  state = createPanelState();
});

describe('current', () => {
  it('is nothing until the window is known, then the first workspace in this window', () => {
    state.workspaces = [ws('a'), ws('b')];
    expect(state.current()).toBeUndefined();
    state.windowId = windowId;
    expect(state.current()?.id).toBe('a');
  });

  it('is the one selected for this window when it holds several, if it is still there', () => {
    state.windowId = windowId;
    state.workspaces = [ws('a'), ws('b')];
    state.selection = { [windowId]: 'b' };
    expect(state.current()?.id).toBe('b');
    state.selection = { [windowId]: 'gone' };
    expect(state.current()?.id).toBe('a');
  });

  it('ignores workspaces in other windows', () => {
    state.windowId = windowId;
    state.workspaces = [ws('elsewhere', { windowId: windowId + 1 })];
    expect(state.current()).toBeUndefined();
  });
});

describe('selectJoiners', () => {
  it('does not treat the first state as anyone joining', async () => {
    state.windowId = windowId;
    state.selectJoiners([ws('a'), ws('b')]);
    await flush();
    expect(selected()).toBeUndefined();
  });

  it('selects a workspace that has just arrived in this window', async () => {
    state.windowId = windowId;
    state.selectJoiners([ws('a'), ws('b', { windowId: null })]);
    state.selectJoiners([ws('a'), ws('b')]);
    await flush();
    expect(selected()).toEqual({ [windowId]: 'b' });
  });

  it('selects nothing while the window is unknown, and nothing for an arrival elsewhere', async () => {
    state.selectJoiners([ws('a', { windowId: null })]);
    state.selectJoiners([ws('a')]);
    state.windowId = windowId;
    state.selectJoiners([ws('a'), ws('b', { windowId: windowId + 1 })]);
    await flush();
    expect(selected()).toBeUndefined();
  });
});

describe('followActiveTab', () => {
  it('switches to the workspace whose group holds the active tab, and shows only that group', async () => {
    const other = fake.addTab(windowId, 'https://example.com/b', { active: true });
    const groupId = fake.addGroup([other.id]);
    state.windowId = windowId;
    state.workspaces = [ws('a'), ws('b', { groupId })];
    await state.followActiveTab();
    await flush();
    expect(selected()).toEqual({ [windowId]: 'b' });
    expect(showOnly).toHaveBeenCalledWith(windowId, groupId);
  });

  it('does nothing while the window is unknown, for a tab in no group, or when already on that workspace', async () => {
    state.workspaces = [ws('a')];
    await state.followActiveTab();
    state.windowId = windowId;
    await state.followActiveTab();
    const tab = fake.addTab(windowId, 'https://example.com/a', { active: true });
    const groupId = fake.addGroup([tab.id]);
    state.workspaces = [ws('a', { groupId })];
    await state.followActiveTab();
    await flush();
    expect(selected()).toBeUndefined();
    expect(showOnly).not.toHaveBeenCalled();
  });
});
