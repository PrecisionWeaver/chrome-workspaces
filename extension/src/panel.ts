import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { similarity } from '../../shared/pairing';
import {
  WORKSPACE_COLORS,
  type ClientMessage,
  type HistoryEntry,
  type ReviewRequest,
  type ReviewsState,
  type ServerMessage,
  type Workspace,
  type WorkspaceStatus,
} from '../../shared/protocol';
import { el } from './dom';
import { connectControl, getHelper, openSocket, startHelper } from './helper-client';
import { createCreateView } from './create-view';
import { attachFileDrop } from './file-drop';
import { createGitView } from './git-view';
import { needsInputCount } from '../../shared/attention';
import { nextIndex, resolveTheme } from '../../shared/keynav';
import { splitList } from '../../shared/list-filter';
import { ticketUrl } from '../../shared/jira';
import { closeMenu, menuItem, openMenu } from './menu';
import { loadPrefs, onPrefsChange, type Prefs } from './prefs';
import { createPalette, type PaletteItem } from './palette';
import { createMonitorView } from './monitor-view';
import { createSettingsView } from './settings-view';
import { makeSectionsResizable } from './sections';
import { noteReviewTab, openInWorkspace } from './tabs';
import { createLauncher } from './launcher';
import { loadSelection, onSelectionChange, select, shownIn, type Selection } from './selection';
import { showOnly, switchTo } from './windows';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const listEl = $<HTMLUListElement>('workspaces');
const newButton = $<HTMLButtonElement>('new');
const noticeEl = $<HTMLDivElement>('notice');
const pickerEl = $<HTMLElement>('picker');
const pickerOptions = $<HTMLUListElement>('picker-options');
const pickerNew = $<HTMLFormElement>('picker-new');
const pickerName = $<HTMLInputElement>('picker-name');
const terminalEl = $<HTMLDivElement>('terminal');

const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 12, cursorBlink: true, theme: { background: '#1e1e1e' } });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(terminalEl);

const DARK_TERMINAL = { background: '#1e1e1e' };
const LIGHT_TERMINAL = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#1f2328',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(31, 111, 235, 0.25)',
};
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let appearance: Prefs | null = null;

/** Applies the theme and density to the page and the terminal; `system` follows the operating system. */
function applyAppearance(prefs: Prefs | null = appearance): void {
  if (!prefs) return;
  appearance = prefs;
  const theme = resolveTheme(prefs.theme, systemDark.matches);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.density = prefs.density;
  term.options.theme = theme === 'light' ? LIGHT_TERMINAL : DARK_TERMINAL;
  monitor.setTheme(theme === 'light' ? LIGHT_TERMINAL : DARK_TERMINAL);
}
void loadPrefs().then(applyAppearance);
onPrefsChange(applyAppearance);
systemDark.addEventListener('change', () => applyAppearance());

let myWindowId: number | undefined;
let workspaces: Workspace[] = [];
let statuses: Record<string, WorkspaceStatus> = {};
let reviews: ReviewsState = { items: [], error: null, fetchedAt: null };
let history: HistoryEntry[] = [];
// The Jira site from the config, learned from the system snapshot; null hides every ticket link.
let jiraBase: string | null = null;

const control = connectControl(
  (message) => {
    if (message.type === 'prompts') creator.setPrompts(message.prompts, message.error);
    if (message.type === 'repos') creator.setRepos(message.repos);
    if (message.type === 'history') {
      history = message.entries;
      renderList();
    }
    if (message.type === 'timeline') settings.setTimeline(message);
    if (message.type === 'updates') settings.setUpdates(message);
    if (message.type === 'system') {
      settings.setSystem(message);
      jiraBase = message.snapshot?.config.jiraBaseUrl ?? jiraBase;
      const attention = settings.warningCount + settings.setupRemaining;
      $<HTMLButtonElement>('settings-open').classList.toggle('has-warning', attention > 0);
      $<HTMLButtonElement>('settings-open').title = attention ? `Settings · ${attention} to look at` : 'Settings';
    }
    if (message.type === 'adminResult') settings.setResult(message);
    if (message.type === 'systemLog') settings.setLog(message.text);
    if (message.type === 'exportData') settings.download(message.json);
    if (message.type === 'sessionReset' && attachedId === message.id) {
      // The helper replaced this workspace's session; attach to the new one.
      detach();
      render();
    }
    if (message.type === 'git') git.setState(message);
    if (message.type === 'gitCommit') git.setCommit(message);
    if (message.type === 'gitDiff') git.setDiff(message);
    if (message.type === 'gitResult') git.setResult(message);
    if (message.type === 'gitBranches') git.setBranches(message);
    if (message.type === 'gitChecks') git.setChecks(message);
    if (message.type === 'gitCompare') git.setCompare(message);
    if (message.type === 'prDetails') creator.setPrDetails(message.url, message.details, message.error);
    if (message.type === 'prThreads') creator.setPrThreads(message);
    if (message.type !== 'state') return;
    selectJoiners(message.workspaces);
    const shown = current();
    const wasStatus = shown ? statuses[shown.id] : undefined;
    workspaces = message.workspaces;
    statuses = message.statuses;
    // Claude starting or finishing work means files likely changed.
    if (shown && statuses[shown.id] !== wasStatus) git.refresh();
    reviews = message.reviews;
    render();
  },
  (connected) => (connected ? showNotice(null) : showOfflineNotice()),
);
const send = control.send.bind(control);
const here = () => ({ windowId: myWindowId, workspace: current() });
// Review requests start a workspace through the same new-workspace view as the + button.
/** Opens the new-workspace view for a review request, and its PR beside the current workspace's tabs. */
function startReview(review: ReviewRequest): void {
  creator.show(review);
  // The PR is what you came to look at, so it opens beside the workspace's other tabs, once.
  // A tab opened here moves to the PR's workspace when one is made from this view.
  const { windowId, workspace } = here();
  void openInWorkspace(workspace, windowId, review.url).then((tabId) => {
    if (tabId !== undefined) void noteReviewTab(review.url, tabId);
  });
}

const launcher = createLauncher({
  send,
  create: startReview,
  closeCreate: () => creator.close(),
  selectedUrl: () => creator.review?.url ?? null,
  openWorkspace,
});
const creator = createCreateView({
  send,
  onToggle() {
    if (creator.isOpen) {
      git.close();
      settings.close();
      monitor.close();
    }
    render();
  },
  here,
  ticketLink: (ticket) => ticketUrl(jiraBase, ticket),
});
const git = createGitView({
  send,
  status: (id) => statuses[id] ?? null,
  onToggle() {
    if (git.isOpen) {
      creator.close();
      settings.close();
      monitor.close();
    }
    render();
  },
});
const settings = createSettingsView({
  send,
  onToggle() {
    if (settings.isOpen) {
      creator.close();
      git.close();
      monitor.close();
    }
    render();
  },
});
const monitor = createMonitorView({
  onToggle() {
    if (monitor.isOpen) {
      creator.close();
      git.close();
      settings.close();
    }
    render();
  },
});
$<HTMLButtonElement>('monitor-open').addEventListener('click', () => (monitor.isOpen ? monitor.close() : monitor.show()));
$<HTMLButtonElement>('settings-open').addEventListener('click', () => (settings.isOpen ? settings.close() : settings.show()));

// Which workspace this window shows when it holds several; chosen from the list, or by the tab being worked in.
let selection: Selection = {};
void loadSelection().then((loaded) => {
  selection = loaded;
  render();
});
onSelectionChange((changed) => {
  selection = changed;
  render();
});

function current(): Workspace | undefined {
  return shownIn(myWindowId, workspaces, selection);
}

// Where each workspace was in the previous state, to notice one arriving in this window.
let previousWindows: Map<string, number | null> | null = null;

/** A workspace that has just joined this window, by being created or paired here, is the one to show. */
function selectJoiners(next: readonly Workspace[]): void {
  if (previousWindows && myWindowId !== undefined) {
    const joined = next.find((ws) => ws.windowId === myWindowId && previousWindows!.get(ws.id) !== myWindowId);
    if (joined) void select(joined);
  }
  previousWindows = new Map(next.map((ws) => [ws.id, ws.windowId]));
}

/** Working in a tab that belongs to a workspace's group switches to that workspace. */
async function followActiveTab(): Promise<void> {
  if (myWindowId === undefined) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId: myWindowId });
  const owner = workspaces.find((ws) => ws.windowId === myWindowId && ws.groupId !== null && ws.groupId === tab?.groupId);
  if (!owner || owner.id === current()?.id) return;
  void select(owner);
  void showOnly(owner.windowId!, owner.groupId);
}

chrome.tabs.onActivated.addListener(({ windowId }) => windowId === myWindowId && void followActiveTab());

// Chrome's tab group colors by group id, shown on the badges of workspaces that have a group.
const groupColors = new Map<number, string>();

async function loadGroupColors(): Promise<void> {
  groupColors.clear();
  for (const group of await chrome.tabGroups.query({})) groupColors.set(group.id, group.color);
  renderList();
}

void loadGroupColors();
chrome.tabGroups.onCreated.addListener(() => void loadGroupColors());
chrome.tabGroups.onUpdated.addListener(() => void loadGroupColors());
chrome.tabGroups.onRemoved.addListener(() => void loadGroupColors());

function showNotice(text: string | null): void {
  noticeEl.hidden = text === null;
  noticeEl.textContent = text ?? '';
}

function showOfflineNotice(): void {
  const start = el('button', 'Start helper', 'notice-action');
  start.type = 'button';
  const message = el('span', 'Helper not running.');
  start.onclick = () => {
    start.disabled = true;
    message.textContent = 'Starting the helper…';
    // On success the control connection's backoff reconnects and clears this notice.
    startHelper().catch((error) => {
      message.textContent = `Could not start the helper: ${error instanceof Error ? error.message : String(error)}. Try npm run agent:start.`;
      start.disabled = false;
    });
  };
  noticeEl.hidden = false;
  noticeEl.replaceChildren(message, start);
}

// ---- list ----

// The workspace the last render showed; the views over the terminal belong to it.
let shownId: string | undefined;

function render(): void {
  renderList();
  launcher.renderReviews(reviews, workspaces);
  const workspace = current();
  // Switching workspaces returns to the terminal: the new-workspace, review and diff views are left behind.
  if (shownId !== undefined && workspace?.id !== shownId) {
    shownId = workspace?.id;
    creator.close();
    git.close();
    settings.close();
    monitor.close();
  }
  shownId = workspace?.id;
  git.setWorkspace(workspace);
  git.renderStatus();
  const overlay = creator.isOpen || git.isOpen || settings.isOpen || monitor.isOpen;
  pickerEl.hidden = overlay || workspace !== undefined;
  terminalEl.hidden = overlay || workspace === undefined;
  if (workspace) attach(workspace);
  else {
    detach();
    if (!overlay) void renderPicker();
  }
}

// While a name is being edited or a workspace dragged the list isn't redrawn (status updates
// arrive constantly and would discard the input or the drag); it catches up when that ends.
let editing = false;
let dragged: Workspace | null = null;

const listSearch = $<HTMLInputElement>('list-search');
let archivedOpen = false;
let closedOpen = false;
void chrome.storage.local.get('archivedOpen').then(({ archivedOpen: saved }) => {
  archivedOpen = saved === true;
  renderList();
});
listSearch.addEventListener('input', renderList);
listSearch.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  listSearch.value = '';
  renderList();
});

function renderList(): void {
  const waiting = needsInputCount(
    statuses,
    workspaces.map((ws) => ws.id),
  );
  $<HTMLSpanElement>('list-title').textContent = waiting ? `Workspaces · ${waiting} waiting` : 'Workspaces';
  if (editing || dragged) return;
  // A filter box earns its room once the list is long enough to need one.
  listSearch.hidden = workspaces.length < 5 && listSearch.value === '';
  const here = current();
  const { active, archived } = splitList(workspaces, statuses, listSearch.value);
  const rows = active.map(({ ws, number }) => workspaceRow(ws, number, here));
  if (archived.length) {
    const toggle = document.createElement('li');
    toggle.className = 'archived-toggle';
    toggle.textContent = `${archivedOpen ? '▾' : '▸'} Archived (${archived.length})`;
    toggle.addEventListener('click', () => {
      archivedOpen = !archivedOpen;
      void chrome.storage.local.set({ archivedOpen });
      renderList();
    });
    rows.push(toggle);
    // A search that matches only archived workspaces shows them, so they can be found.
    if (archivedOpen || listSearch.value.trim()) rows.push(...archived.map((ws) => workspaceRow(ws, null, here)));
  }
  // Removed workspaces, kept so one can be brought back with its conversation.
  const closed = history.filter((entry) => !listSearch.value.trim() || entry.name.toLowerCase().includes(listSearch.value.trim().toLowerCase()));
  if (closed.length) {
    const toggle = document.createElement('li');
    toggle.className = 'archived-toggle';
    toggle.textContent = `${closedOpen ? '▾' : '▸'} Recently closed (${closed.length})`;
    toggle.addEventListener('click', () => {
      closedOpen = !closedOpen;
      renderList();
    });
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
  const { windowId, workspace } = here();
  // Into this window as a group when it already holds a workspace; otherwise a window of its own.
  send({ type: 'restore', historyId: entry.id, windowId: workspace && windowId !== undefined ? windowId : null });
}

function closedRow(entry: HistoryEntry): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'ws archived closed';
  item.dataset.id = entry.id;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-label', `${entry.name}, closed. Press Enter to restore.`);
  item.title = `${entry.name}\n${entry.cwd}\nClosed ${new Date(entry.closedAt).toLocaleString()}${entry.resumeId ? '\nResumes its conversation' : ''}\nClick to restore`;
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
    send({ type: 'forget', historyId: entry.id });
  });
  item.append(badge, name, forget);
  item.addEventListener('click', () => restoreWorkspace(entry));
  return item;
}

function workspaceRow(ws: Workspace, number: number | null, here: Workspace | undefined): HTMLLIElement {
  const item = document.createElement('li');
  item.className = `ws${ws.id === here?.id ? ' current' : ''}${ws.archived ? ' archived' : ''}`;
  item.dataset.id = ws.id;
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', String(ws.id === here?.id));
  const live = statuses[ws.id];
  item.setAttribute(
    'aria-label',
    `${ws.name}${live === 'needs_input' ? ', needs input' : live === 'working' ? ', working' : live === 'idle' ? ', idle' : ''}${ws.pinned ? ', pinned' : ''}${ws.archived ? ', archived' : ''}`,
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
  remove.title = 'Remove workspace';
  remove.textContent = '×';
  remove.addEventListener('click', (event) => {
    event.stopPropagation();
    // Two clicks: the first arms it, so a stray click can't end a running session.
    if (!remove.classList.contains('confirm')) {
      remove.classList.add('confirm');
      remove.textContent = 'remove?';
      setTimeout(renderList, 3000);
      return;
    }
    send({ type: 'remove', id: ws.id });
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
    if (ws.id !== here?.id) openWorkspace(ws);
    else {
      creator.close();
      git.close();
    }
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
  const ticket = ticketUrl(jiraBase, ws.ticket);
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
      send({ type: 'mark', id: ws.id, color });
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
      menuItem(ws.pinned ? 'Unpin' : 'Pin to top', () => send({ type: 'mark', id: ws.id, pinned: !ws.pinned })),
      menuItem(ws.archived ? 'Unarchive' : 'Archive', () => send({ type: 'mark', id: ws.id, archived: !ws.archived })),
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
    const rest = workspaces.filter((w) => w.id !== moving.id);
    const index = rest.findIndex((w) => w.id === ws.id) + (after ? 1 : 0);
    // Reorder now rather than waiting for the helper's state, so the list doesn't jump back.
    workspaces = [...rest.slice(0, index), moving, ...rest.slice(index)];
    send({ type: 'move', id: moving.id, index });
  });
  // Fires after drop, or alone when the drag is cancelled.
  item.addEventListener('dragend', () => {
    dragged = null;
    renderList();
  });
}

function openWorkspace(ws: Workspace): void {
  // Opening a panel needs a user gesture, so do it before anything awaits.
  if (ws.windowId !== null) chrome.sidePanel.open({ windowId: ws.windowId }).catch(() => {});
  void select(ws);
  void switchTo(ws, send, workspaces);
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
    if (save && name && name !== ws.name) send({ type: 'rename', id: ws.id, name });
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

newButton.addEventListener('click', () => creator.show());

$<HTMLButtonElement>('collapse').addEventListener('click', () => {
  const collapsed = document.body.classList.toggle('collapsed');
  void chrome.storage.local.set({ listCollapsed: collapsed });
  fitTerminal();
});

void chrome.storage.local.get(['listCollapsed', 'listWidth']).then(({ listCollapsed, listWidth }) => {
  document.body.classList.toggle('collapsed', listCollapsed === true);
  if (typeof listWidth === 'number') setListWidth(listWidth);
  fitTerminal();
});

const MIN_LIST_WIDTH = 140;
const MAX_LIST_WIDTH = 520;
const resizer = $<HTMLDivElement>('list-resizer');

function setListWidth(width: number): number {
  const clamped = Math.min(MAX_LIST_WIDTH, Math.max(MIN_LIST_WIDTH, Math.round(width)));
  document.body.style.setProperty('--list-width', `${clamped}px`);
  return clamped;
}

resizer.addEventListener('pointerdown', (event) => {
  resizer.setPointerCapture(event.pointerId);
  resizer.classList.add('dragging');
});

resizer.addEventListener('pointermove', (event) => {
  if (resizer.hasPointerCapture(event.pointerId)) setListWidth(event.clientX);
});

resizer.addEventListener('pointerup', (event) => {
  resizer.releasePointerCapture(event.pointerId);
  resizer.classList.remove('dragging');
  void chrome.storage.local.set({ listWidth: setListWidth(event.clientX) });
  fitTerminal();
});

// ---- unpaired window ----

async function renderPicker(): Promise<void> {
  if (myWindowId === undefined) return;
  const tabs = await chrome.tabs.query({ windowId: myWindowId });
  const urls = tabs.flatMap((tab) => (tab.url ? [tab.url] : []));
  const ranked = [...workspaces].sort(
    (a, b) => similarity(b.lastTabUrls, urls) - similarity(a.lastTabUrls, urls) || Number(a.windowId !== null) - Number(b.windowId !== null),
  );

  pickerOptions.replaceChildren(
    ...ranked.map((ws) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.textContent = ws.name;
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = ws.windowId === null ? 'no window' : 'moves here from its window';
      button.append(hint);
      button.addEventListener('click', () => myWindowId !== undefined && send({ type: 'pair', id: ws.id, windowId: myWindowId }));
      item.append(button);
      return item;
    }),
  );
}

pickerNew.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = pickerName.value.trim();
  if (name && myWindowId !== undefined) send({ type: 'create', name, windowId: myWindowId });
  pickerName.value = '';
});

// ---- terminal ----

let socket: WebSocket | null = null;
let attachedId: string | null = null;
// Set while the token is being fetched, so a state update arriving meanwhile doesn't attach twice.
let connecting = false;

function sendToSession(message: ClientMessage): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function detach(): void {
  const old = socket;
  socket = null;
  attachedId = null;
  old?.close();
}

function attach(workspace: Workspace): void {
  if (attachedId === workspace.id && (socket || connecting)) return;
  detach();
  term.reset();
  attachedId = workspace.id;
  connecting = true;

  getHelper().then(
    (helper) => {
      connecting = false;
      if (attachedId !== workspace.id) return;
      const ws = openSocket(helper, `/attach?session=${workspace.id}`);
      socket = ws;

      ws.onopen = () => {
        fitTerminal();
        term.focus();
      };
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type === 'output') {
          if (!message.replay) term.write(message.data);
          else {
            replaying = true;
            term.write(message.data, () => (replaying = false));
          }
        }
        // The saved path is pasted, so a program that takes pastes (claude) treats it as an attachment.
        else if (message.type === 'uploaded') {
          if (message.path) term.paste(`${message.path} `);
          else showNotice(`Could not add ${message.name}: ${message.error ?? 'unknown error'}`);
        }
        // The shell is gone; close the panel. Reopening it starts a fresh session.
        else if (myWindowId !== undefined) void chrome.sidePanel.close({ windowId: myWindowId });
        else window.close();
      };
      ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        term.write('\r\n\x1b[33m[disconnected from helper — reconnects when it is back]\x1b[0m\r\n');
      };
    },
    () => {
      // The control connection's notice explains the outage; the next state retries the attach.
      connecting = false;
      attachedId = null;
    },
  );
}

// Replayed scrollback can hold terminal queries (device attributes, say); xterm answers them through onData,
// and the shell would read each answer as typed text. Output written while a replay is parsed is dropped.
let replaying = false;
term.onData((data) => {
  if (!replaying) sendToSession({ type: 'input', data });
});

attachFileDrop(terminalEl, {
  send: (name, data) => sendToSession({ type: 'file', name, data }),
  notice: showNotice,
});

// xterm sends the same \r for Enter and Shift+Enter; Claude reads ESC + \r as a newline, as iTerm can be set to send.
term.attachCustomKeyEventHandler((event) => {
  // ⌘K / Ctrl+K is the palette's, even while the terminal has focus: the terminal ignores it, and the
  // same keypress then reaches the page-level handler below, which opens the palette. Opening it here as
  // well would open and immediately close it, so this only declines the key.
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') return false;
  if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true;
  if (event.type === 'keydown') sendToSession({ type: 'input', data: '\x1b\r' });
  return false;
});

function fitTerminal(): void {
  if (terminalEl.hidden) return;
  fit.fit();
  sendToSession({ type: 'resize', cols: term.cols, rows: term.rows });
}

new ResizeObserver(fitTerminal).observe(terminalEl);

// Resource warnings are checked once a minute while the panel is open, so the gear can say so; Settings
// itself polls faster while it is showing.
setInterval(() => {
  if (document.visibilityState === 'visible' && !settings.isOpen) send({ type: 'system' });
}, 60_000);
send({ type: 'system' });

function paletteItems(): PaletteItem[] {
  const items: PaletteItem[] = [
    { kind: 'Action', label: 'New workspace', hint: 'Start a workspace', run: () => creator.show() },
    { kind: 'Action', label: 'System monitor', hint: 'btop, in the panel', run: () => monitor.show() },
    { kind: 'Action', label: 'Open settings', hint: 'Helper, sessions, housekeeping', run: () => settings.show() },
    { kind: 'Action', label: 'Refresh review requests', run: () => send({ type: 'refreshReviews' }) },
    { kind: 'Action', label: 'Refresh source control', run: () => git.refresh() },
    {
      kind: 'Action',
      label: document.body.classList.contains('collapsed') ? 'Expand the list' : 'Collapse the list',
      run: () => $<HTMLButtonElement>('collapse').click(),
    },
  ];
  const shown = current();
  for (const ws of workspaces) {
    const status = statuses[ws.id];
    items.push({
      kind: ws.archived ? 'Workspace · archived' : 'Workspace',
      label: ws.name,
      hint: [
        ws.id === shown?.id ? 'current' : '',
        status === 'needs_input' ? 'needs input' : status === 'working' ? 'working' : '',
        ws.cwd.replace(/^\/Users\/[^/]+/, '~'),
      ]
        .filter(Boolean)
        .join(' · '),
      run: () => openWorkspace(ws),
    });
  }
  for (const ws of workspaces) {
    const url = ticketUrl(jiraBase, ws.ticket);
    if (url) items.push({ kind: 'Ticket', label: `${ws.ticket} · ${ws.name}`, hint: 'Open in Jira', run: () => void chrome.tabs.create({ url }) });
  }
  for (const entry of history) {
    items.push({
      kind: 'Restore',
      label: entry.name,
      hint: `closed ${new Date(entry.closedAt).toLocaleDateString()}${entry.resumeId ? ' · resumes its conversation' : ''}`,
      run: () => restoreWorkspace(entry),
    });
  }
  for (const review of reviews.items) {
    const existing = workspaces.find((ws) => ws.pr === review.url);
    items.push({
      kind: existing ? 'Review · has workspace' : 'Review',
      label: `${review.repo.split('/')[1] ?? review.repo}#${review.number} ${review.title}`,
      hint: review.author,
      run: () => (existing ? openWorkspace(existing) : startReview(review)),
    });
  }
  return items;
}

const palette = createPalette(paletteItems, () => (terminalEl.hidden ? undefined : term.focus()));
// Outside the terminal the same shortcut works anywhere in the panel.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (palette.isOpen) palette.close();
    else palette.open();
  }
});

makeSectionsResizable(fitTerminal);

void chrome.windows.getCurrent().then((win) => {
  myWindowId = win.id;
  render();
});
