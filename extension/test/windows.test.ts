import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlToHelper, Workspace } from '../../shared/protocol';
import { noteReviewTab } from '../src/tabs';
import { createGroup, openWindow, recordSharedSize, showOnly, switchTo } from '../src/windows';
import { installChrome } from './chrome-mock';

const PR = 'https://github.com/acme/app/pull/12';

let fake: ReturnType<typeof installChrome>;
let sent: ControlToHelper[];
const send = (message: ControlToHelper) => (sent.push(message), true);

beforeEach(() => {
  fake = installChrome();
  sent = [];
});
afterEach(() => vi.unstubAllGlobals());

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return { id: 'ws1', name: 'acme', windowId: null, groupId: null, url: null, pr: null, lastTabUrls: [], color: null, ...overrides } as Workspace;
}

describe('recordSharedSize', () => {
  it('remembers bounds, or maximized, from normal windows only', () => {
    recordSharedSize({ type: 'popup', state: 'normal', left: 1, top: 2, width: 3, height: 4 } as chrome.windows.Window);
    expect(fake.storage.local.sharedSize).toBeUndefined();
    recordSharedSize({ type: 'normal', state: 'minimized' } as chrome.windows.Window);
    expect(fake.storage.local.sharedSize).toBeUndefined();
    recordSharedSize({ type: 'normal', state: 'normal', left: 10, top: 20, width: 800, height: 600 } as chrome.windows.Window);
    expect(fake.storage.local.sharedSize).toEqual({ left: 10, top: 20, width: 800, height: 600 });
    recordSharedSize({ type: 'normal', state: 'maximized' } as chrome.windows.Window);
    expect(fake.storage.local.sharedSize).toEqual({ maximized: true });
  });
});

describe('openWindow', () => {
  it("opens the workspace's last tabs, falling back to its url, and pairs the new window", async () => {
    const id = await openWindow(workspace({ lastTabUrls: ['https://a.example/', 'https://b.example/'] }), send);
    expect(fake.urls(id!)).toEqual(['https://a.example/', 'https://b.example/']);
    expect(sent).toEqual([{ type: 'pair', id: 'ws1', windowId: id }]);

    const other = await openWindow(workspace({ url: 'https://c.example/' }), send);
    expect(fake.urls(other!)).toEqual(['https://c.example/']);
  });

  it('opens the window at the shared size, and falls back when Chrome refuses the position', async () => {
    fake.storage.local.sharedSize = { left: -5000, top: 0, width: 800, height: 600 };
    fake.refuse.positioned = true;
    await openWindow(workspace({ url: 'https://c.example/' }), send);
    expect(fake.windowUpdates).toEqual([{ state: 'normal', width: 800, height: 600 }]);
  });

  it('opens at the shared size, maximized when that was last', async () => {
    fake.storage.local.sharedSize = { maximized: true };
    await openWindow(workspace({ url: 'https://c.example/' }), send);
    expect(fake.windowUpdates).toEqual([{ state: 'maximized' }]);
  });

  it('leads with the PR tab its review request opened, rather than opening a second copy', async () => {
    const { windowId } = fake.addWindow();
    const pr = fake.addTab(windowId, `${PR}/files`);
    await noteReviewTab(PR, pr.id);

    const id = await openWindow(workspace({ pr: PR, lastTabUrls: [PR, 'https://b.example/'] }), send);
    expect(fake.tab(pr.id)?.windowId).toBe(id);
    expect(fake.urls(id!)).toEqual([`${PR}/files`, 'https://b.example/']);
  });
});

describe('createGroup', () => {
  it("opens the workspace's tabs as a titled, coloured group and pairs it", async () => {
    const { windowId } = fake.addWindow();
    await createGroup(workspace({ windowId, name: 'acme/app', color: 'blue', lastTabUrls: ['https://a.example/', 'https://b.example/'] }), send);

    const [message] = sent as Extract<ControlToHelper, { type: 'pair' }>[];
    expect(message).toMatchObject({ type: 'pair', id: 'ws1', windowId });
    expect(fake.inGroup(message!.groupId!)).toEqual(['https://a.example/', 'https://b.example/']);
    expect(fake.group(message!.groupId!)).toMatchObject({ title: 'acme/app', color: 'blue', collapsed: false });
  });

  it('does nothing when the window is gone', async () => {
    await createGroup(workspace({ windowId: 999, lastTabUrls: ['https://a.example/'] }), send);
    expect(sent).toEqual([]);
  });

  it('moves the review request tab in from where it was opened instead of duplicating it', async () => {
    const { windowId } = fake.addWindow();
    const pr = fake.addTab(windowId, PR);
    await noteReviewTab(PR, pr.id);

    await createGroup(workspace({ windowId, pr: PR, lastTabUrls: [PR, 'https://b.example/'] }), send);

    const groupId = (sent[0] as { groupId: number }).groupId;
    expect(fake.inGroup(groupId)).toEqual([PR, 'https://b.example/']);
    expect(fake.tab(pr.id)).toMatchObject({ groupId, active: true });
    expect(fake.urls(windowId).filter((url) => url === PR)).toHaveLength(1);
  });

  it('moves the PR tab in from a different window', async () => {
    const { windowId } = fake.addWindow();
    const { windowId: reviewWindow } = fake.addWindow();
    const pr = fake.addTab(reviewWindow, PR);
    await noteReviewTab(PR, pr.id);

    await createGroup(workspace({ windowId, pr: PR, lastTabUrls: [PR] }), send);

    expect(fake.tab(pr.id)).toMatchObject({ windowId, groupId: (sent[0] as { groupId: number }).groupId });
  });

  it('opens its own copy when the review tab was the only one in its window', async () => {
    const { windowId } = fake.addWindow();
    const { windowId: reviewWindow, tab: pr } = fake.addWindow(PR);
    await noteReviewTab(PR, pr.id);

    await createGroup(workspace({ windowId, pr: PR, lastTabUrls: [PR] }), send);

    expect(fake.tab(pr.id)?.windowId).toBe(reviewWindow);
    expect(fake.inGroup((sent[0] as { groupId: number }).groupId)).toEqual([PR]);
  });

  it('collapses the other groups in the window, leaving the new one open', async () => {
    const { windowId, tab } = fake.addWindow();
    const other = fake.addGroup([tab.id]);
    await createGroup(workspace({ windowId, lastTabUrls: ['https://a.example/'] }), send);
    expect(fake.group(other)?.collapsed).toBe(true);
    expect(fake.group((sent[0] as { groupId: number }).groupId)?.collapsed).toBe(false);
  });
});

describe('showOnly', () => {
  it('collapses every group but the one shown', async () => {
    const { windowId } = fake.addWindow();
    const a = fake.addGroup([fake.addTab(windowId, 'https://a.example/').id]);
    const b = fake.addGroup([fake.addTab(windowId, 'https://b.example/').id]);
    const c = fake.addGroup([fake.addTab(windowId, 'https://c.example/').id]);
    await showOnly(windowId, b);
    expect([a, b, c].map((id) => fake.group(id)?.collapsed)).toEqual([true, false, true]);
  });

  it('for a workspace without a group, leaves a grouped tab and goes to the most recent ungrouped one', async () => {
    const { windowId, tab: first } = fake.addWindow('https://one.example/');
    const second = fake.addTab(windowId, 'https://two.example/');
    const grouped = fake.addTab(windowId, 'https://g.example/', { active: true });
    const group = fake.addGroup([grouped.id]);
    first.active = false;
    first.lastAccessed = 1;
    second.lastAccessed = 100;

    await showOnly(windowId, null);

    expect(fake.tab(second.id)?.active).toBe(true);
    expect(fake.group(group)?.collapsed).toBe(true);
  });

  it('leaves everything alone when no ungrouped tab exists to switch to', async () => {
    const { windowId, tab } = fake.addWindow();
    const group = fake.addGroup([tab.id]);
    await showOnly(windowId, null);
    expect(fake.tab(tab.id)?.active).toBe(true);
    expect(fake.group(group)?.collapsed).toBe(false);
  });
});

describe('switchTo', () => {
  it('focuses the workspace window and expands and activates its group', async () => {
    const { windowId, tab } = fake.addWindow();
    const second = fake.addTab(windowId, 'https://b.example/');
    const group = fake.addGroup([tab.id, second.id], { collapsed: true });
    // With no tab active in the group, the most recently used one comes forward.
    tab.active = false;
    tab.lastAccessed = 1;
    second.active = false;
    second.lastAccessed = 500;

    const id = await switchTo(workspace({ windowId, groupId: group }), send);

    expect(id).toBe(windowId);
    expect(fake.group(group)?.collapsed).toBe(false);
    expect(fake.tab(second.id)?.active).toBe(true);
    expect(sent).toEqual([]);
  });

  it('collapses the other workspaces sharing the window', async () => {
    const { windowId, tab } = fake.addWindow();
    const mine = fake.addGroup([tab.id], { collapsed: true });
    const theirs = fake.addGroup([fake.addTab(windowId, 'https://b.example/').id]);
    const a = workspace({ id: 'a', windowId, groupId: mine });
    const b = workspace({ id: 'b', windowId, groupId: theirs });

    await switchTo(a, send, [a, b]);

    expect(fake.group(theirs)?.collapsed).toBe(true);
    expect(fake.group(mine)?.collapsed).toBe(false);
  });

  it('opens a fresh window when the workspace window has closed', async () => {
    const id = await switchTo(workspace({ windowId: 999, url: 'https://c.example/' }), send);
    expect(id).not.toBe(999);
    expect(fake.urls(id!)).toEqual(['https://c.example/']);
    expect(sent).toEqual([{ type: 'pair', id: 'ws1', windowId: id }]);
  });
});
