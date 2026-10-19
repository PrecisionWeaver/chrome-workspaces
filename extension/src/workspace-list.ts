import { needsInputCount } from '../../shared/attention';
import { nextIndex } from '../../shared/keynav';
import { filterList } from '../../shared/list-filter';
import { type ControlToHelper, type HistoryEntry, type Workspace, type WorkspaceStatus, WORKSPACE_COLORS } from '../../shared/protocol';
import { caret } from './dom';
import { closeMenu, menuItem, openMenu } from './menu';

export interface WorkspaceListOptions {
  send(message: ControlToHelper): void;
  /** The panel owns this data: the terminal, the picker and the palette read it too. */
  state(): { workspaces: Workspace[]; statuses: Record<string, WorkspaceStatus>; history: HistoryEntry[] };
  /** The workspace this window is showing. */
  current(): Workspace | undefined;
  windowId(): number | undefined;
  ticketLink(ticket: string | null): string | null;
  /** Shows a workspace: its window, its tab group, its terminal. */
  open(ws: Workspace): void;
  /** The current workspace was clicked again: close whatever view covers its terminal. */
  onReselect(): void;
  /** A drag moved a workspace; the panel keeps the new order until the helper confirms it. */
  reorder(next: Workspace[]): void;
}

export interface WorkspaceList {
  render(): void;
  /** Brings an archived workspace back, into this window as a tab group when it already holds one. */
  restore(entry: HistoryEntry): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** The workspace list in the side panel: rows, filter, archived workspaces, context menu, drag to reorder and rename. */
export function createWorkspaceList(options: WorkspaceListOptions): WorkspaceList {
  const listEl = $<HTMLUListElement>('workspaces');
  // Chrome's tab group colors by group id, shown on the badges of workspaces that have a group.
  const groupColors = new Map<number, string>();

  async function loadGroupColors(): Promise<void> {
    groupColors.clear();
    for (const group of await chrome.tabGroups.query({})) groupColors.set(group.id, group.color);
    renderList();
  }

  // While a name is being edited or a workspace dragged the list isn't redrawn (status updates
  // arrive constantly and would discard the input or the drag); it catches up when that ends.
  let editing = false;
  let dragged: Workspace | null = null;

  const listSearch = $<HTMLInputElement>('list-search');
  let closedOpen = false;
  listSearch.addEventListener('input', renderList);
  listSearch.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    listSearch.value = '';
    renderList();
  });

  function renderList(): void {
    const { workspaces, statuses, history } = options.state();
    const waiting = needsInputCount(
      statuses,
      workspaces.map((ws) => ws.id),
    );
    $<HTMLSpanElement>('list-title').textContent = waiting ? `Workspaces · ${waiting} waiting` : 'Workspaces';
    if (editing || dragged) return;
    // A filter box earns its room once the list is long enough to need one.
    listSearch.hidden = workspaces.length < 5 && listSearch.value === '';
    const here = options.current();
    const rows = filterList(workspaces, statuses, listSearch.value).map(({ ws, number }) => workspaceRow(ws, number, here));
    // Archived workspaces, kept so one can be brought back with its conversation.
    const closed = history.filter((entry) => !listSearch.value.trim() || entry.name.toLowerCase().includes(listSearch.value.trim().toLowerCase()));
    if (closed.length) {
      const toggle = document.createElement('li');
      toggle.className = 'archived-toggle';
      toggle.append(caret(closedOpen), `Archived (${closed.length})`);
      toggle.addEventListener('click', () => {
        closedOpen = !closedOpen;
        renderList();
      });
      if (closedOpen || listSearch.value.trim()) toggle.append(clearArchivedButton());
      rows.push(toggle);
      if (closedOpen || listSearch.value.trim()) rows.push(...closed.map(closedRow));
    }
    if (rows.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'list-empty';
      empty.textContent = listSearch.value ? 'No workspace matches' : 'No workspaces yet';
      rows.push(empty);
    }
    // Status updates redraw the list constantly; a row being navigated to must keep focus through that.
    const focusedId = listEl.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.id : undefined;
    listEl.replaceChildren(...rows);
    if (focusedId) listEl.querySelector<HTMLElement>(`[data-id="${focusedId}"]`)?.focus();
    // One row is a tab stop (the current one, else the first), and the arrow keys move among the rest.
    const stops = [...listEl.querySelectorAll<HTMLElement>('.ws[data-id]')];
    const stop = stops.find((row) => row.classList.contains('current')) ?? stops[0];
    for (const row of stops) row.tabIndex = row === stop ? 0 : -1;
  }

  listEl.setAttribute('role', 'listbox');
  listEl.setAttribute('aria-label', 'Workspaces');
  listEl.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    // Typing in the rename box must not move focus away.
    if (target.tagName === 'INPUT') return;
    const rows = [...listEl.querySelectorAll<HTMLElement>('.ws[data-id]')];
    const at = rows.indexOf(target.closest<HTMLElement>('.ws[data-id]') as HTMLElement);
    if (event.key === 'Enter' || event.key === ' ') {
      if (at >= 0) {
        event.preventDefault();
        rows[at].click();
      }
      return;
    }
    if (event.key === 'F2' && at >= 0) {
      event.preventDefault();
      rows[at].querySelector<HTMLElement>('.name')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return;
    }
    const next = nextIndex(event.key, at, rows.length);
    if (next === null) return;
    event.preventDefault();
    rows[next].focus();
  });

  function restoreWorkspace(entry: HistoryEntry): void {
    const windowId = options.windowId();
    // Into this window as a group when it already holds a workspace; otherwise a window of its own.
    options.send({ type: 'restore', historyId: entry.id, windowId: options.current() && windowId !== undefined ? windowId : null });
  }

  /** Forgets every archived workspace. Two clicks, like removing one: it can't be undone. */
  function clearArchivedButton(): HTMLButtonElement {
    const clear = document.createElement('button');
    clear.className = 'archived-clear';
    clear.textContent = 'Clear all';
    clear.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!clear.classList.contains('confirm')) {
        clear.classList.add('confirm');
        clear.textContent = 'Forget all?';
        setTimeout(renderList, 3000);
        return;
      }
      options.send({ type: 'forgetAll' });
    });
    return clear;
  }

  function closedRow(entry: HistoryEntry): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'ws archived closed';
    item.dataset.id = entry.id;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-label', `${entry.name}, archived. Press Enter to restore.`);
    item.title = `${entry.name}\n${entry.cwd}\nArchived ${new Date(entry.closedAt).toLocaleString()}${entry.resumeId ? '\nResumes its conversation' : ''}\nClick to restore`;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '↺';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = entry.name;
    const forget = document.createElement('button');
    forget.className = 'remove';
    forget.title = 'Forget this workspace';
    forget.textContent = '×';
    forget.addEventListener('click', (event) => {
      event.stopPropagation();
      options.send({ type: 'forget', historyId: entry.id });
    });
    item.append(badge, name, forget);
    item.addEventListener('click', () => restoreWorkspace(entry));
    return item;
  }

  function workspaceRow(ws: Workspace, number: number | null, here: Workspace | undefined): HTMLLIElement {
    const item = document.createElement('li');
    item.className = `ws${ws.id === here?.id ? ' current' : ''}`;
    item.dataset.id = ws.id;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(ws.id === here?.id));
    const { statuses } = options.state();
    const live = statuses[ws.id];
    item.setAttribute(
      'aria-label',
      `${ws.name}${live === 'needs_input' ? ', needs input' : live === 'working' ? ', working' : live === 'idle' ? ', idle' : ''}${ws.pinned ? ', pinned' : ''}`,
    );
    item.title = `${ws.name}\n${ws.cwd}${ws.groupId === null ? '' : '\nTab group'}\nRight-click for more`;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = number === null ? '–' : String(number);
    const status = statuses[ws.id];
    if (status) badge.dataset.status = status;
    // A workspace in a tab group wears the group's color; otherwise the one it was marked with.
    const color = (ws.groupId === null ? undefined : groupColors.get(ws.groupId)) ?? ws.color ?? undefined;
    if (color) badge.dataset.group = color;

    const name = document.createElement('span');
    name.className = `name${ws.windowId === null ? ' windowless' : ''}`;
    name.textContent = ws.name;
    name.title = 'Double-click to rename';
    name.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      startRename(ws, name);
    });

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.title = 'Archive workspace';
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      // Two clicks: the first arms it, so a stray click can't end a running session.
      if (!remove.classList.contains('confirm')) {
        remove.classList.add('confirm');
        remove.textContent = 'archive?';
        setTimeout(renderList, 3000);
        return;
      }
      options.send({ type: 'remove', id: ws.id });
    });

    item.append(badge, name);
    if (ws.pinned) {
      const pin = document.createElement('span');
      pin.innerHTML = '<svg class="icon"><use href="#i-pin"/></svg>';
      pin.className = 'pin';
      pin.title = 'Pinned';
      item.append(pin);
    }
    item.append(remove);
    item.addEventListener('click', () => {
      if (ws.id !== here?.id) options.open(ws);
      else options.onReselect();
    });
    item.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      showContextMenu(event.clientX, event.clientY, ws, name);
    });
    addDragHandlers(item, ws);
    return item;
  }

  // ---- right-click menu ----

  function showContextMenu(x: number, y: number, ws: Workspace, nameEl: HTMLElement): void {
    const ticket = options.ticketLink(ws.ticket);
    const swatches = document.createElement('div');
    swatches.className = 'ctx-swatches';
    for (const color of [null, ...WORKSPACE_COLORS]) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      // In a tab group the group's color is what the badge shows, so that is the one marked as selected.
      const shown = (ws.groupId === null ? undefined : groupColors.get(ws.groupId)) ?? ws.color;
      swatch.className = `swatch${(shown ?? null) === color ? ' selected' : ''}`;
      swatch.title = color ?? 'No color';
      if (color) swatch.dataset.group = color;
      else swatch.textContent = '×';
      swatch.addEventListener('click', () => {
        closeMenu();
        options.send({ type: 'mark', id: ws.id, color });
        // The badge follows the tab group's color when there is one, so recolor the group too, as Chrome's own picker does.
        if (color && ws.groupId !== null) {
          const groupId = ws.groupId;
          void chrome.tabGroups
            .update(groupId, { color: color as chrome.tabGroups.Color })
            .then(() => {
              groupColors.set(groupId, color);
              renderList();
            })
            .catch(() => {});
        }
      });
      swatches.append(swatch);
    }
    openMenu(
      x,
      y,
      [
        menuItem(ws.pinned ? 'Unpin' : 'Pin to top', () => options.send({ type: 'mark', id: ws.id, pinned: !ws.pinned })),
        menuItem('Archive', () => options.send({ type: 'remove', id: ws.id })),
        menuItem('Archive & close tabs', () => options.send({ type: 'remove', id: ws.id, closeTabs: true })),
        menuItem('Rename', () => startRename(ws, nameEl)),
        ...(ticket ? [menuItem(`Open ${ws.ticket}`, () => void chrome.tabs.create({ url: ticket }))] : []),
        swatches,
      ],
      'ctx-menu',
    );
  }

  function addDragHandlers(item: HTMLLIElement, ws: Workspace): void {
    item.draggable = true;
    item.addEventListener('dragstart', (event) => {
      dragged = ws;
      item.classList.add('dragging');
      event.dataTransfer?.setData('text/plain', ws.name);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    });
    item.addEventListener('dragover', (event) => {
      if (!dragged) return;
      event.preventDefault();
      const { top, height } = item.getBoundingClientRect();
      const after = event.clientY > top + height / 2;
      item.classList.toggle('drop-before', !after);
      item.classList.toggle('drop-after', after);
    });
    item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      const moving = dragged;
      const after = item.classList.contains('drop-after');
      if (!moving || moving.id === ws.id) return;
      const rest = options.state().workspaces.filter((w) => w.id !== moving.id);
      const index = rest.findIndex((w) => w.id === ws.id) + (after ? 1 : 0);
      // Reorder now rather than waiting for the helper's state, so the list doesn't jump back.
      options.reorder([...rest.slice(0, index), moving, ...rest.slice(index)]);
      options.send({ type: 'move', id: moving.id, index });
    });
    // Fires after drop, or alone when the drag is cancelled.
    item.addEventListener('dragend', () => {
      dragged = null;
      renderList();
    });
  }

  function startRename(ws: Workspace, nameEl: HTMLElement): void {
    editing = true;
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = ws.name;
    input.maxLength = 80;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (save && name && name !== ws.name) options.send({ type: 'rename', id: ws.id, name });
      editing = false;
      renderList();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') finish(true);
      else if (event.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (event) => event.stopPropagation());
  }

  void loadGroupColors();
  chrome.tabGroups.onCreated.addListener(() => void loadGroupColors());
  chrome.tabGroups.onUpdated.addListener(() => void loadGroupColors());
  chrome.tabGroups.onRemoved.addListener(() => void loadGroupColors());

  return { render: renderList, restore: restoreWorkspace };
}
