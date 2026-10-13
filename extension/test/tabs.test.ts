import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../shared/protocol';
import { findTab, noteReviewTab, openInWorkspace, takeReviewTab } from '../src/tabs';
import { installChrome } from './chrome-mock';

const PR = 'https://github.com/acme/app/pull/12';

let fake: ReturnType<typeof installChrome>;
beforeEach(() => {
  fake = installChrome();
});
afterEach(() => vi.unstubAllGlobals());

const workspace = (windowId: number | null, groupId: number | null) => ({ windowId, groupId }) as Workspace;

describe('findTab', () => {
  it('looks inside a group when given one, and only among ungrouped tabs otherwise', () => {
    const { windowId } = fake.addWindow('https://example.com/');
    const inside = fake.addTab(windowId, PR);
    const group = fake.addGroup([inside.id]);
    const loose = fake.addTab(windowId, 'https://github.com/acme/app/pull/13');

    return Promise.all([
      expect(findTab(windowId, group, PR)).resolves.toMatchObject({ id: inside.id }),
      expect(findTab(windowId, null, PR)).resolves.toBeUndefined(),
      expect(findTab(windowId, null, 'https://github.com/acme/app/pull/13')).resolves.toMatchObject({ id: loose.id }),
      expect(findTab(windowId, group, 'https://github.com/acme/app/pull/13')).resolves.toBeUndefined(),
    ]);
  });

  it('counts a page beneath the url, such as a PR files tab, as the page', async () => {
    const { windowId } = fake.addWindow(`${PR}/files?w=1`);
    await expect(findTab(windowId, null, PR)).resolves.toMatchObject({ url: `${PR}/files?w=1` });
  });
});

describe('openInWorkspace', () => {
  it('opens a plain tab in the window when the workspace has no group', async () => {
    const { windowId } = fake.addWindow();
    const id = await openInWorkspace(workspace(windowId, null), undefined, PR);
    expect(fake.tab(id!)).toMatchObject({ windowId, url: PR, groupId: -1, active: true });
  });

  it('adds the tab to the workspace group when it has one', async () => {
    const { windowId, tab } = fake.addWindow();
    const group = fake.addGroup([tab.id]);
    const id = await openInWorkspace(workspace(windowId, group), undefined, PR);
    expect(fake.tab(id!)?.groupId).toBe(group);
  });

  it('opens in the current window when there is no workspace, and still ungrouped', async () => {
    const { windowId } = fake.addWindow();
    const id = await openInWorkspace(undefined, windowId, PR);
    expect(fake.tab(id!)).toMatchObject({ windowId, groupId: -1 });
  });

  it('brings an existing tab forward instead of opening a second, and reports it as not new', async () => {
    const { windowId } = fake.addWindow();
    const existing = fake.addTab(windowId, PR);
    const id = await openInWorkspace(workspace(windowId, null), undefined, PR);
    expect(id).toBeUndefined();
    expect(fake.urls(windowId)).toHaveLength(2);
    expect(fake.tab(existing.id)?.active).toBe(true);
  });

  it('does not treat a tab in a group as the page when asked for an ungrouped one', async () => {
    const { windowId } = fake.addWindow();
    const grouped = fake.addTab(windowId, PR);
    fake.addGroup([grouped.id]);
    const id = await openInWorkspace(workspace(windowId, null), undefined, PR);
    expect(id).toBeDefined();
    expect(fake.tab(id!)?.groupId).toBe(-1);
  });

  it('keeps the tab in the window when the group closed in the meantime', async () => {
    const { windowId, tab } = fake.addWindow();
    const group = fake.addGroup([tab.id]);
    fake.removeGroup(group);
    const id = await openInWorkspace(workspace(windowId, group), undefined, PR);
    expect(fake.tab(id!)).toMatchObject({ windowId, groupId: -1 });
  });
});

describe('noteReviewTab and takeReviewTab', () => {
  it('hands back the noted tab once, then forgets it', async () => {
    const { windowId } = fake.addWindow();
    const tab = fake.addTab(windowId, PR);
    await noteReviewTab(PR, tab.id);
    await expect(takeReviewTab(PR)).resolves.toMatchObject({ id: tab.id });
    await expect(takeReviewTab(PR)).resolves.toBeUndefined();
  });

  it('returns nothing for another url, or none, and keeps the note for the right one', async () => {
    const { windowId } = fake.addWindow();
    const tab = fake.addTab(windowId, PR);
    await noteReviewTab(PR, tab.id);
    await expect(takeReviewTab(null)).resolves.toBeUndefined();
    await expect(takeReviewTab('https://github.com/acme/app/pull/99')).resolves.toBeUndefined();
    await expect(takeReviewTab(PR)).resolves.toMatchObject({ id: tab.id });
  });

  it('returns nothing when the tab has closed or navigated elsewhere', async () => {
    const { windowId } = fake.addWindow();
    const closed = fake.addTab(windowId, PR);
    await noteReviewTab(PR, closed.id);
    fake.removeTab(closed.id);
    await expect(takeReviewTab(PR)).resolves.toBeUndefined();

    const moved = fake.addTab(windowId, PR);
    await noteReviewTab(PR, moved.id);
    moved.url = 'https://example.com/';
    await expect(takeReviewTab(PR)).resolves.toBeUndefined();
  });

  it('refuses the last tab in its window, since moving it would close the window', async () => {
    const { tab } = fake.addWindow(PR);
    await noteReviewTab(PR, tab.id);
    await expect(takeReviewTab(PR)).resolves.toBeUndefined();
  });
});
