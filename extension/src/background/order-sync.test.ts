import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlToHelper } from '../../../shared/protocol/protocol';
import type { Workspace } from '../../../shared/protocol/workspace';
import { installChrome } from '../../testing/chrome-mock';
import { makeWorkspace } from '../../testing/fixtures';
import { installOrderSync } from './order-sync';

let fake: ReturnType<typeof installChrome>;
let list: Workspace[];
let sent: ControlToHelper[];
let sync: ReturnType<typeof installOrderSync>;

beforeEach(() => {
  vi.useFakeTimers();
  fake = installChrome();
  sent = [];
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = () => vi.advanceTimersByTimeAsync(0);

/** Three workspaces, each in a group, with the tab strip showing them in the order given. */
function threeGroups() {
  const { windowId, tab } = fake.addWindow('https://example.com/a');
  const b = fake.addTab(windowId, 'https://example.com/b');
  const c = fake.addTab(windowId, 'https://example.com/c');
  const [ga, gb, gc] = [fake.addGroup([tab.id]), fake.addGroup([b.id]), fake.addGroup([c.id])] as [number, number, number];
  list = [
    makeWorkspace({ id: 'ws-a', windowId, groupId: ga }),
    makeWorkspace({ id: 'ws-b', windowId, groupId: gb }),
    makeWorkspace({ id: 'ws-c', windowId, groupId: gc }),
  ];
  sync = installOrderSync({ workspaces: () => list, send: (message) => (sent.push(message), true) });
  sync.noteState(list);
  const strip = () => fake.mock.tabs.query({ windowId }).then((tabs) => tabs.map((t) => t.groupId));
  return { windowId, ga, gb, gc, strip };
}

describe('the list reordered', () => {
  it('moves the tab groups to follow it', async () => {
    const { ga, gb, gc, strip } = threeGroups();
    expect(await strip()).toEqual([ga, gb, gc]);
    list = [list[2]!, list[0]!, list[1]!];
    sync.noteState(list);
    await settle();
    expect(await strip()).toEqual([gc, ga, gb]);
  });

  it('leaves the tab strip alone when only something other than the order changed, and for the first state', async () => {
    threeGroups();
    expect(fake.mock.tabGroups.move).not.toHaveBeenCalled();
    list = list.map((ws) => ({ ...ws, name: 'renamed' }));
    sync.noteState(list);
    await settle();
    expect(fake.mock.tabGroups.move).not.toHaveBeenCalled();
  });
});

describe('a group dragged in the strip', () => {
  it('reorders the list once the drag settles', async () => {
    const { windowId, gc } = threeGroups();
    await fake.mock.tabGroups.move(gc, { index: 0 });
    fake.events.tabGroups.onMoved.emit({ id: gc, windowId } as chrome.tabGroups.TabGroup);
    fake.events.tabGroups.onMoved.emit({ id: gc, windowId } as chrome.tabGroups.TabGroup);
    await vi.advanceTimersByTimeAsync(399);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual([{ type: 'order', ids: ['ws-c', 'ws-a', 'ws-b'] }]);
  });

  it('does not read its own moves back as a drag, until a second has passed', async () => {
    const { windowId, gc } = threeGroups();
    list = [list[2]!, list[0]!, list[1]!];
    sync.noteState(list);
    await settle();

    fake.events.tabGroups.onMoved.emit({ id: gc, windowId } as chrome.tabGroups.TabGroup);
    await vi.advanceTimersByTimeAsync(400);
    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(1000);
    fake.events.tabGroups.onMoved.emit({ id: gc, windowId } as chrome.tabGroups.TabGroup);
    await vi.advanceTimersByTimeAsync(400);
    // The strip already matches the list, so there is nothing to send.
    expect(sent).toEqual([]);
  });
});
