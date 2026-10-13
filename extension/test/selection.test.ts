import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSelection, onSelectionChange, select, shownIn } from '../src/selection';
import { installChrome } from './chrome-mock';
import { makeWorkspace } from './fixtures';

let fake: ReturnType<typeof installChrome>;
beforeEach(() => {
  fake = installChrome();
});
afterEach(() => vi.unstubAllGlobals());

describe('select and loadSelection', () => {
  it('stores the choice by window, keeping other windows', async () => {
    await select(makeWorkspace({ id: 'a', windowId: 1 }));
    await select(makeWorkspace({ id: 'b', windowId: 2 }));
    await expect(loadSelection()).resolves.toEqual({ '1': 'a', '2': 'b' });
  });

  it('starts empty, and ignores a workspace with no window', async () => {
    await expect(loadSelection()).resolves.toEqual({});
    await select(makeWorkspace({ windowId: null }));
    expect(fake.mock.storage.local.set).not.toHaveBeenCalled();
  });

  it('does not write when the workspace is already selected', async () => {
    const workspace = makeWorkspace({ id: 'a', windowId: 1 });
    await select(workspace);
    await select(workspace);
    expect(fake.mock.storage.local.set).toHaveBeenCalledTimes(1);
  });
});

describe('onSelectionChange', () => {
  it('reports each change from local storage, and an empty selection once cleared', async () => {
    const listener = vi.fn();
    onSelectionChange(listener);
    await select(makeWorkspace({ id: 'a', windowId: 1 }));
    expect(listener).toHaveBeenLastCalledWith({ '1': 'a' });
    fake.events.storage.onChanged.emit({ selectedByWindow: { oldValue: { '1': 'a' } } }, 'local');
    expect(listener).toHaveBeenLastCalledWith({});
  });

  it('ignores other keys and other storage areas', () => {
    const listener = vi.fn();
    onSelectionChange(listener);
    fake.events.storage.onChanged.emit({ prefs: { newValue: {} } }, 'local');
    fake.events.storage.onChanged.emit({ selectedByWindow: { newValue: { '1': 'a' } } }, 'session');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('shownIn', () => {
  const a = makeWorkspace({ id: 'a', windowId: 1 });
  const b = makeWorkspace({ id: 'b', windowId: 1 });
  const other = makeWorkspace({ id: 'c', windowId: 2 });

  it("shows the selected workspace if it is still in the window, else the window's first", () => {
    expect(shownIn(1, [a, b, other], { '1': 'b' })).toBe(b);
    expect(shownIn(1, [a, b, other], { '1': 'gone' })).toBe(a);
    expect(shownIn(1, [a, b, other], {})).toBe(a);
  });

  it('ignores a selection that belongs to another window, and finds nothing in a window with none', () => {
    expect(shownIn(1, [a, b, other], { '1': 'c' })).toBe(a);
    expect(shownIn(3, [a, b, other], {})).toBeUndefined();
    expect(shownIn(undefined, [a], {})).toBeUndefined();
  });
});
