// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { ControlToHelper, HistoryEntry, WaitingOn, Workspace, WorkspaceStatus } from '../../../shared/protocol/protocol';
import { installChrome } from '../../testing/chrome-mock';
import { isolateDocumentListeners, loadPanelHtml, makeHistoryEntry, makeWorkspace } from '../../testing/fixtures';
import { createWorkspaceList, type WorkspaceList, type WorkspaceListOptions } from './workspace-list';

isolateDocumentListeners();

let fake: ReturnType<typeof installChrome>;
let windowId: number;
let list: WorkspaceList;
let sent: ControlToHelper[];
let data: { workspaces: Workspace[]; statuses: Record<string, WorkspaceStatus>; waiting: Record<string, WaitingOn>; history: HistoryEntry[] };
let currentId: string | null;
let jiraBase: string | null;
/** What the list asked the panel to do, as (action, argument) pairs. */
let actions: Mock<(action: string, detail?: string) => void>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = () => vi.advanceTimersByTimeAsync(0);
const sentOfType = <T extends ControlToHelper['type']>(type: T) =>
  sent.filter((message): message is Extract<ControlToHelper, { type: T }> => message.type === type);
const rows = () => [...document.querySelectorAll<HTMLElement>('#workspaces li.ws[data-id]')];
const names = () => rows().map((row) => row.querySelector('.name')!.textContent);
const ws = (id: string, overrides: Partial<Workspace> = {}) => makeWorkspace({ id, name: `acme/${id}`, windowId, ...overrides });

beforeEach(() => {
  vi.useFakeTimers();
  fake = installChrome();
  windowId = fake.addWindow('https://example.com/start').windowId;
  loadPanelHtml();
  sent = [];
  data = { workspaces: [], statuses: {}, waiting: {}, history: [] };
  currentId = null;
  jiraBase = null;
  actions = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Builds the list over the test's data; the first workspace is the current one unless said otherwise. */
async function build(overrides: Partial<WorkspaceListOptions> = {}) {
  list = createWorkspaceList({
    send: (message) => void sent.push(message),
    state: () => data,
    current: () => data.workspaces.find((w) => w.id === (currentId ?? data.workspaces[0]?.id)),
    windowId: () => windowId,
    ticketLink: (ticket) => (ticket && jiraBase ? `${jiraBase}/browse/${ticket}` : null),
    open: (w) => actions('open', w.id),
    openShell: (w) => actions('openShell', w.id),
    popOut: (w) => actions('popOut', w.id),
    onReselect: () => actions('reselect'),
    reorder: (next) => {
      data.workspaces = next;
      actions('reorder', next.map((w) => w.id).join(','));
    },
    ...overrides,
  });
  await flush();
}

/** What the panel does on every state message. */
function state(workspaces: Workspace[], statuses: Record<string, WorkspaceStatus> = {}, waiting: Record<string, WaitingOn> = {}) {
  data = { ...data, workspaces, statuses, waiting };
  list.render();
}
function history(entries: HistoryEntry[]) {
  data = { ...data, history: entries };
  list.render();
}

describe('the rows', () => {
  it('shows each workspace, numbered, with its name and what it is doing', async () => {
    await build();
    state([ws('a'), ws('b')], { a: 'working', b: 'needs_input' });
    expect(names()).toEqual(['acme/a', 'acme/b']);
    expect(rows().map((row) => row.querySelector('.badge')!.textContent)).toEqual(['1', '2']);
    expect(rows().map((row) => row.querySelector<HTMLElement>('.badge')!.dataset.status)).toEqual(['working', 'needs_input']);
    expect(rows()[1]!.getAttribute('aria-label')).toBe('acme/b, needs input');
    expect(rows()[0]!.title).toContain('/Users/me/acme');
  });

  it('says what a waiting workspace is waiting on', async () => {
    await build();
    state([ws('a')], { a: 'needs_input' }, { a: { type: 'permission_prompt', message: 'Claude needs your permission to use Bash' } });
    expect(rows()[0]!.getAttribute('aria-label')).toBe('acme/a, needs permission');
    expect(rows()[0]!.title).toContain('Claude needs your permission to use Bash');
  });

  it('says how many are waiting in the title, the count apart from the word', async () => {
    await build();
    state([ws('a'), ws('b')], { a: 'needs_input', b: 'needs_input' });
    expect($('list-title').textContent).toBe('2 waiting');
    expect($('list-title').querySelector('.count')!.textContent).toBe('2');
    expect($('list-title').title).toBe('2 waiting');
    state([ws('a')]);
    expect($('list-title').textContent).toBe('');
  });

  it('marks the current workspace, pinned ones, a windowless one, and the colour it was given', async () => {
    await build();
    state([ws('a', { pinned: true, color: 'blue' }), ws('b', { windowId: null })]);
    expect(rows()[0]!.classList.contains('current')).toBe(true);
    expect(rows()[0]!.getAttribute('aria-selected')).toBe('true');
    expect(rows()[0]!.querySelector('.pin')).not.toBeNull();
    expect(rows()[0]!.getAttribute('aria-label')).toContain('pinned');
    expect(rows()[0]!.querySelector<HTMLElement>('.badge')!.dataset.group).toBe('blue');
    expect(rows()[1]!.querySelector('.pin')).toBeNull();
    expect(rows()[1]!.getAttribute('aria-selected')).toBe('false');
    expect(rows()[1]!.querySelector('.name')!.classList.contains('windowless')).toBe(true);
  });

  it('wears the tab group’s colour when the workspace is in one, and follows the group as it changes', async () => {
    const tab = fake.addTab(windowId, 'https://example.com/a');
    const groupId = fake.addGroup([tab.id]);
    await fake.mock.tabGroups.update(groupId, { color: 'red' as chrome.tabGroups.Color });
    await build();
    state([ws('a', { groupId, color: 'blue' })]);
    const badge = () => rows()[0]!.querySelector<HTMLElement>('.badge')!;
    expect(badge().dataset.group).toBe('red');
    expect(rows()[0]!.title).toContain('Tab group');
    await fake.mock.tabGroups.update(groupId, { color: 'green' as chrome.tabGroups.Color });
    fake.events.tabGroups.onUpdated.emit(fake.group(groupId)!);
    await flush();
    expect(badge().dataset.group).toBe('green');
  });

  it('says there is nothing yet', async () => {
    await build();
    state([]);
    expect(document.querySelector('#workspaces .list-empty')!.textContent).toBe('No workspaces yet');
  });
});

describe('the filter', () => {
  it('shows – for a row hidden by the search, keeping each workspace’s own number', async () => {
    await build();
    state(['a', 'b', 'c', 'd', 'e'].map((id) => ws(id)));
    expect($('list-search').hidden).toBe(false);
    $<HTMLInputElement>('list-search').value = 'acme/d';
    $('list-search').dispatchEvent(new Event('input'));
    expect(names()).toEqual(['acme/d']);
    expect(rows()[0]!.querySelector('.badge')!.textContent).toBe('4');
  });

  it('hides the box until there are five, and says when nothing matches', async () => {
    await build();
    state([ws('a')]);
    expect($('list-search').hidden).toBe(true);
    state(['a', 'b', 'c', 'd', 'e'].map((id) => ws(id)));
    $<HTMLInputElement>('list-search').value = 'zzz';
    $('list-search').dispatchEvent(new Event('input'));
    expect(rows()).toHaveLength(0);
    expect(document.querySelector('#workspaces .list-empty')!.textContent).toBe('No workspace matches');
    // The box stays while it holds a filter, even once the list is short again.
    state([ws('a')]);
    expect($('list-search').hidden).toBe(false);
  });

  it('clears the filter on Escape', async () => {
    await build();
    state(['a', 'b', 'c', 'd', 'e'].map((id) => ws(id)));
    $<HTMLInputElement>('list-search').value = 'acme/d';
    $('list-search').dispatchEvent(new Event('input'));
    $('list-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(names()).toEqual(['acme/d']);
    $('list-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect($<HTMLInputElement>('list-search').value).toBe('');
    expect(names()).toHaveLength(5);
  });
});

describe('clicking a row', () => {
  it('opens another workspace, and tells the panel when the current one is clicked again', async () => {
    await build();
    state([ws('a'), ws('b')]);
    rows()[1]!.click();
    expect(actions).toHaveBeenLastCalledWith('open', 'b');
    rows()[0]!.click();
    expect(actions).toHaveBeenLastCalledWith('reselect');
  });

  it('opens a workspace in its own window from its row, without selecting it', async () => {
    await build();
    state([ws('a'), ws('b')]);
    const popOut = rows()[1]!.querySelector<HTMLButtonElement>('.pop-out')!;
    expect(popOut.querySelector('use')?.getAttribute('href')).toBe('#i-external');
    popOut.click();
    expect(actions).toHaveBeenCalledWith('popOut', 'b');
    expect(actions).not.toHaveBeenCalledWith('open', 'b');
  });
});

describe('archiving', () => {
  const remove = () => rows()[0]!.querySelector<HTMLButtonElement>('.remove')!;

  it('asks twice, and the first click disarms after three seconds', async () => {
    await build();
    state([ws('a')]);
    remove().click();
    expect(remove().textContent).toBe('archive?');
    expect(remove().classList.contains('confirm')).toBe(true);
    expect(sentOfType('remove')).toEqual([]);
    vi.advanceTimersByTime(3000);
    expect(remove().textContent).toBe('');
    expect(remove().querySelector('use')?.getAttribute('href')).toBe('#i-x');
    remove().click();
    remove().click();
    expect(sentOfType('remove')).toEqual([{ type: 'remove', id: 'a' }]);
    expect(actions).not.toHaveBeenCalledWith('open', 'a');
  });

  it('keeps the confirmation through a redraw, so the second click still lands', async () => {
    await build();
    state([ws('a')]);
    remove().click();
    state([ws('a')]);
    expect(remove().textContent).toBe('archive?');
    remove().click();
    expect(sentOfType('remove')).toEqual([{ type: 'remove', id: 'a' }]);
  });
});

describe('the context menu', () => {
  const menuButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu > button')];
  const openMenu = async (workspace: Workspace) => {
    await build();
    state([workspace]);
    rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  };

  it('offers pin, archive, archive and close, rename, a shell and earlier conversations', async () => {
    await openMenu(ws('a'));
    expect(menuButtons().map((b) => b.textContent)).toEqual([
      'Pin to top',
      'Archive',
      'Archive & close tabs',
      'Rename',
      'Open a shell here',
      'Resume an earlier conversation…',
    ]);
  });

  it('pins and unpins', async () => {
    await openMenu(ws('a'));
    menuButtons()[0]!.click();
    expect(sentOfType('mark')).toEqual([{ type: 'mark', id: 'a', pinned: true }]);
    state([ws('a', { pinned: true })]);
    rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(menuButtons()[0]!.textContent).toBe('Unpin');
    menuButtons()[0]!.click();
    expect(sentOfType('mark').at(-1)).toEqual({ type: 'mark', id: 'a', pinned: false });
  });

  it('archives with or without closing the tabs', async () => {
    await openMenu(ws('a'));
    menuButtons()[1]!.click();
    rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    menuButtons()[2]!.click();
    expect(sentOfType('remove')).toEqual([
      { type: 'remove', id: 'a' },
      { type: 'remove', id: 'a', closeTabs: true },
    ]);
  });

  it('starts a rename, and opens a shell in the workspace’s directory', async () => {
    await openMenu(ws('a'));
    menuButtons()[3]!.click();
    expect(document.querySelector<HTMLInputElement>('input.rename')!.value).toBe('acme/a');
    rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    menuButtons()
      .find((b) => b.textContent === 'Open a shell here')!
      .click();
    expect(actions).toHaveBeenCalledWith('openShell', 'a');
  });

  it('asks for earlier conversations, lists them where the menu was, and resumes the one picked', async () => {
    await openMenu(ws('a'));
    menuButtons()
      .find((b) => b.textContent === 'Resume an earlier conversation…')!
      .click();
    expect(sentOfType('listSessions')).toEqual([{ type: 'listSessions', id: 'a' }]);
    list.showSessions({
      type: 'sessions',
      id: 'a',
      sessions: [
        { id: '22222222-2222-2222-2222-222222222222', startedAt: '2026-02-01T10:00:00Z', status: 'idle', firstPrompt: 'and the tests' },
        { id: '11111111-1111-1111-1111-111111111111', startedAt: '2026-01-01T10:00:00Z', status: null, firstPrompt: null },
      ],
    });
    const menu = document.querySelector<HTMLElement>('.ctx-menu')!;
    expect(menu.style.left).toBe('10px');
    const labels = menuButtons().map((b) => b.textContent);
    expect(labels[0]).toContain('and the tests');
    expect(labels[0]).toContain('current');
    expect(menuButtons()[0]!.disabled).toBe(true);
    expect(menuButtons()[0]!.title).toBe('The conversation this workspace is on now');
    expect(labels[1]).toContain('no prompt recorded');
    expect(menuButtons()[1]!.title).toBe('End the current session and resume this one');
    menuButtons()[1]!.click();
    expect(sentOfType('resumeSession')).toEqual([{ type: 'resumeSession', id: 'a', sessionId: '11111111-1111-1111-1111-111111111111' }]);
    list.showSessions({ type: 'sessions', id: 'a', sessions: [] });
    expect(menuButtons().map((b) => b.textContent)).toEqual(['No earlier conversation is recorded']);
    expect(menuButtons()[0]!.disabled).toBe(true);
  });

  it('offers the ticket once the Jira site is known', async () => {
    await openMenu(ws('a', { ticket: 'PROJ-123' }));
    expect(menuButtons().map((b) => b.textContent)).not.toContain('Open PROJ-123');
    jiraBase = 'https://jira.example.com';
    rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    menuButtons()
      .find((b) => b.textContent === 'Open PROJ-123')!
      .click();
    expect(fake.mock.tabs.create).toHaveBeenCalledWith({ url: 'https://jira.example.com/browse/PROJ-123' });
  });

  it('colours a workspace, and its tab group too', async () => {
    const tab = fake.addTab(windowId, 'https://example.com/a');
    const groupId = fake.addGroup([tab.id]);
    await openMenu(ws('a', { groupId }));
    const swatches = [...document.querySelectorAll<HTMLButtonElement>('.ctx-swatches .swatch')];
    expect(swatches).toHaveLength(10);
    expect(swatches[0]!.textContent).toBe('×');
    expect(swatches[0]!.title).toBe('No color');
    // In a tab group the group's colour is the one shown, so that is the one marked.
    expect(swatches.find((s) => s.classList.contains('selected'))!.title).toBe('grey');
    swatches[2]!.click();
    await flush();
    expect(sentOfType('mark')).toEqual([{ type: 'mark', id: 'a', color: 'blue' }]);
    expect(fake.group(groupId)?.color).toBe('blue');
    expect(rows()[0]!.querySelector<HTMLElement>('.badge')!.dataset.group).toBe('blue');
  });

  it('clears a colour without touching the tab group, and recolours a group that has gone quietly', async () => {
    await openMenu(ws('a', { color: 'red' as chrome.tabGroups.Color }));
    const swatches = () => [...document.querySelectorAll<HTMLButtonElement>('.ctx-swatches .swatch')];
    expect(swatches().find((s) => s.classList.contains('selected'))!.title).toBe('red');
    swatches()[0]!.click();
    expect(sentOfType('mark')).toEqual([{ type: 'mark', id: 'a', color: null }]);
    expect(fake.mock.tabGroups.update).not.toHaveBeenCalled();

    state([ws('a', { groupId: 999 })]);
    rows()[0]!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    swatches()[2]!.click();
    await flush();
    expect(sentOfType('mark').at(-1)).toEqual({ type: 'mark', id: 'a', color: 'blue' });
  });
});

describe('renaming', () => {
  const startRename = async (workspace = ws('a')) => {
    await build();
    state([workspace]);
    rows()[0]!
      .querySelector('.name')!
      .dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    return document.querySelector<HTMLInputElement>('input.rename')!;
  };

  it('swaps the name for a box holding it, and sends the new one on Enter', async () => {
    const input = await startRename();
    expect(input.value).toBe('acme/a');
    expect(document.activeElement).toBe(input);
    input.value = ' acme/renamed ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(sentOfType('rename')).toEqual([{ type: 'rename', id: 'a', name: 'acme/renamed' }]);
    expect(document.querySelector('input.rename')).toBeNull();
    expect(actions).not.toHaveBeenCalledWith('open', 'a');
  });

  it('sends nothing on Escape, for an unchanged or blank name, and only once if blur follows', async () => {
    let input = await startRename();
    input.value = 'changed';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    input.dispatchEvent(new Event('blur'));
    expect(sentOfType('rename')).toEqual([]);
    input = await startRename();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    input = await startRename();
    input.value = '   ';
    input.dispatchEvent(new Event('blur'));
    expect(sentOfType('rename')).toEqual([]);
  });

  it('keeps the list from redrawing while the name is being edited, and catches up after', async () => {
    const input = await startRename();
    state([ws('a'), ws('b')]);
    expect(rows()).toHaveLength(1);
    expect(document.querySelector('input.rename')).toBe(input);
    input.dispatchEvent(new Event('blur'));
    expect(names()).toEqual(['acme/a', 'acme/b']);
  });

  it('does not select the row when the box is clicked, nor let its keys reach the list', async () => {
    const input = await startRename();
    input.click();
    expect(actions).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(input);
  });
});

describe('the keyboard in the list', () => {
  const key = (target: Element, key: string) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  it('is a listbox with one tab stop, the current workspace', async () => {
    await build();
    currentId = 'b';
    state([ws('a'), ws('b'), ws('c')]);
    expect($('workspaces').getAttribute('role')).toBe('listbox');
    expect(rows().map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
    expect(rows().map((row) => row.getAttribute('role'))).toEqual(['option', 'option', 'option']);
  });

  it('falls back to the first row as the tab stop when none is current', async () => {
    await build({ current: () => undefined });
    state([ws('a'), ws('b')]);
    expect(rows().map((row) => row.tabIndex)).toEqual([0, -1]);
  });

  it('moves focus with the arrows, stopping at the ends', async () => {
    await build();
    state([ws('a'), ws('b'), ws('c')]);
    rows()[0]!.focus();
    expect(key(rows()[0]!, 'ArrowDown').defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(rows()[1]!);
    key(rows()[1]!, 'End');
    expect(document.activeElement).toBe(rows()[2]!);
    key(rows()[2]!, 'ArrowDown');
    expect(document.activeElement).toBe(rows()[2]!);
    key(rows()[2]!, 'Home');
    expect(document.activeElement).toBe(rows()[0]!);
    expect(key(rows()[0]!, 'a').defaultPrevented).toBe(false);
  });

  it('keeps focus on a row through redraws', async () => {
    await build();
    state([ws('a'), ws('b')]);
    rows()[1]!.focus();
    state([ws('a'), ws('b')], { a: 'working' });
    expect(document.activeElement).toBe(rows()[1]!);
  });

  it('opens on Enter or Space, and starts a rename on F2', async () => {
    await build();
    state([ws('a'), ws('b')]);
    expect(key(rows()[1]!, 'Enter').defaultPrevented).toBe(true);
    expect(actions).toHaveBeenLastCalledWith('open', 'b');
    key(rows()[0]!, ' ');
    expect(actions).toHaveBeenLastCalledWith('reselect');
    key(rows()[1]!, 'F2');
    expect(document.querySelector<HTMLInputElement>('input.rename')!.value).toBe('acme/b');
  });

  it('ignores Enter and F2 from outside a row', async () => {
    await build();
    state([ws('a')]);
    key($('workspaces'), 'Enter');
    key($('workspaces'), 'F2');
    expect(actions).not.toHaveBeenCalled();
    expect(document.querySelector('input.rename')).toBeNull();
  });
});

describe('reordering by dragging', () => {
  const drag = (type: string, target: Element, init: { clientY?: number } = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
    event.dataTransfer = { setData() {}, effectAllowed: '' };
    event.clientY = init.clientY ?? 0;
    target.dispatchEvent(event);
    return event;
  };

  it('moves a workspace after the one it is dropped on, in the lower half', async () => {
    await build();
    state([ws('a'), ws('b'), ws('c')]);
    const [a, , c] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    expect(a.draggable).toBe(true);
    drag('dragstart', a);
    expect(a.classList.contains('dragging')).toBe(true);
    c.getBoundingClientRect = () => ({ top: 0, height: 10 }) as DOMRect;
    expect(drag('dragover', c, { clientY: 9 }).defaultPrevented).toBe(true);
    expect(c.classList.contains('drop-after')).toBe(true);
    drag('drop', c);
    expect(actions).toHaveBeenCalledWith('reorder', 'b,c,a');
    expect(sentOfType('move')).toEqual([{ type: 'move', id: 'a', index: 2 }]);
    drag('dragend', a);
    expect(names()).toEqual(['acme/b', 'acme/c', 'acme/a']);
  });

  it('moves it before the one dropped on, in the upper half', async () => {
    await build();
    state([ws('a'), ws('b'), ws('c')]);
    const [, , c] = rows() as [HTMLElement, HTMLElement, HTMLElement];
    drag('dragstart', c);
    const a = rows()[0]!;
    a.getBoundingClientRect = () => ({ top: 0, height: 10 }) as DOMRect;
    drag('dragover', a, { clientY: 1 });
    expect(a.classList.contains('drop-before')).toBe(true);
    drag('drop', a);
    expect(sentOfType('move')).toEqual([{ type: 'move', id: 'c', index: 0 }]);
  });

  it('ignores a drop on itself, and a dragover when nothing is being dragged', async () => {
    await build();
    state([ws('a'), ws('b')]);
    const a = rows()[0]!;
    expect(drag('dragover', a).defaultPrevented).toBe(false);
    drag('dragstart', a);
    drag('drop', a);
    expect(sentOfType('move')).toEqual([]);
    expect(actions).not.toHaveBeenCalledWith('reorder', expect.anything());
  });

  it('clears the drop marks when the drag leaves a row', async () => {
    await build();
    state([ws('a'), ws('b')]);
    const [a, b] = rows() as [HTMLElement, HTMLElement];
    drag('dragstart', a);
    drag('dragover', b);
    drag('dragleave', b);
    expect(b.classList.contains('drop-before') || b.classList.contains('drop-after')).toBe(false);
  });

  it('holds off redrawing during a drag', async () => {
    await build();
    state([ws('a'), ws('b')]);
    drag('dragstart', rows()[0]!);
    state([ws('a'), ws('b'), ws('c')]);
    expect(names()).toEqual(['acme/a', 'acme/b']);
    drag('dragend', rows()[0]!);
    expect(names()).toEqual(['acme/a', 'acme/b', 'acme/c']);
  });
});

describe('archived workspaces', () => {
  const entries: HistoryEntry[] = [makeHistoryEntry({ id: 'h1', name: 'old/one', resumeId: 'r1' }), makeHistoryEntry({ id: 'h2', name: 'old/two' })];
  const toggle = () => document.querySelector<HTMLElement>('.archived-toggle');
  const closed = () => [...document.querySelectorAll<HTMLElement>('.ws.closed')];

  it('folds them under a count, and opens the list on click', async () => {
    await build();
    history(entries);
    expect(toggle()!.textContent).toBe('Archived (2)');
    expect(toggle()!.querySelector('.caret.open')).toBeNull();
    expect(closed()).toHaveLength(0);
    toggle()!.click();
    expect(toggle()!.textContent).toContain('Archived (2)');
    expect(toggle()!.querySelector('.caret.open')).not.toBeNull();
    expect(closed().map((row) => row.querySelector('.name')!.textContent)).toEqual(['old/one', 'old/two']);
    expect(closed()[0]!.title).toContain('Resumes its conversation');
    expect(closed()[1]!.title).not.toContain('Resumes');
    expect(closed()[0]!.getAttribute('aria-label')).toBe('old/one, archived. Press Enter to restore.');
    toggle()!.click();
    expect(closed()).toHaveLength(0);
  });

  it('shows nothing when there is nothing archived', async () => {
    await build();
    history([]);
    expect(toggle()).toBeNull();
  });

  it('restores into a new window when this one holds no workspace', async () => {
    await build();
    history(entries);
    toggle()!.click();
    closed()[0]!.click();
    expect(sentOfType('restore')).toEqual([{ type: 'restore', historyId: 'h1', windowId: null }]);
  });

  it('restores into this window, as a tab group, when it already holds a workspace', async () => {
    await build();
    state([ws('a')]);
    history(entries);
    toggle()!.click();
    closed()[1]!.click();
    expect(sentOfType('restore')).toEqual([{ type: 'restore', historyId: 'h2', windowId }]);
  });

  it('restores from outside the list too, such as the palette', async () => {
    await build();
    state([ws('a')]);
    list.restore(entries[0]!);
    expect(sentOfType('restore')).toEqual([{ type: 'restore', historyId: 'h1', windowId }]);
  });

  it('forgets one with ×, without restoring it', async () => {
    await build();
    history(entries);
    toggle()!.click();
    closed()[0]!.querySelector<HTMLButtonElement>('.remove')!.click();
    expect(sentOfType('forget')).toEqual([{ type: 'forget', historyId: 'h1' }]);
    expect(sentOfType('restore')).toEqual([]);
  });

  it('clears them all after asking twice, and disarms after three seconds', async () => {
    await build();
    history(entries);
    toggle()!.click();
    const clear = () => document.querySelector<HTMLButtonElement>('.archived-clear')!;
    clear().click();
    expect(clear().textContent).toBe('Forget all?');
    expect(sentOfType('forgetAll')).toEqual([]);
    expect(closed()).toHaveLength(2);
    vi.advanceTimersByTime(3000);
    expect(clear().textContent).toBe('Clear all');
    clear().click();
    clear().click();
    expect(sentOfType('forgetAll')).toHaveLength(1);
  });

  it('keeps Clear all armed through a redraw', async () => {
    await build();
    history(entries);
    toggle()!.click();
    const clear = () => document.querySelector<HTMLButtonElement>('.archived-clear')!;
    clear().click();
    history(entries);
    expect(clear().textContent).toBe('Forget all?');
    clear().click();
    expect(sentOfType('forgetAll')).toHaveLength(1);
  });

  it('is searched along with the list, and shown while a filter matches it', async () => {
    await build();
    state(['a', 'b', 'c', 'd', 'e'].map((id) => ws(id)));
    history(entries);
    $<HTMLInputElement>('list-search').value = 'two';
    $('list-search').dispatchEvent(new Event('input'));
    expect(closed().map((row) => row.querySelector('.name')!.textContent)).toEqual(['old/two']);
    expect(toggle()!.textContent).toContain('Archived (1)');
    expect(document.querySelector('.archived-clear')).not.toBeNull();
    $<HTMLInputElement>('list-search').value = 'nothing';
    $('list-search').dispatchEvent(new Event('input'));
    expect(toggle()).toBeNull();
    expect(document.querySelector('#workspaces .list-empty')!.textContent).toBe('No workspace matches');
  });
});
