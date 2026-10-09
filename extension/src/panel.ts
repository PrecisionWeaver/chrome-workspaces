import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { similarity } from '../../shared/pairing';
import type { ClientMessage, ReviewsState, ServerMessage, Workspace, WorkspaceStatus } from '../../shared/protocol';
import { connectControl, getHelper, openSocket } from './helper-client';
import { createCreateView } from './create-view';
import { attachFileDrop } from './file-drop';
import { createGitView } from './git-view';
import { createSettingsView } from './settings-view';
import { makeSectionsResizable } from './sections';
import { openInWorkspace } from './tabs';
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

let myWindowId: number | undefined;
let workspaces: Workspace[] = [];
let statuses: Record<string, WorkspaceStatus> = {};
let reviews: ReviewsState = { items: [], error: null, fetchedAt: null };

const control = connectControl(
  (message) => {
    if (message.type === 'prompts') creator.setPrompts(message.prompts, message.error);
    if (message.type === 'repos') creator.setRepos(message.repos);
    if (message.type === 'system') settings.setSystem(message);
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
    if (message.type === 'prDetails') creator.setPrDetails(message.url, message.details, message.error);
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
  (connected) => showNotice(connected ? null : 'Helper not running. Start it with: npm run agent:start'),
);
const send = control.send.bind(control);
const here = () => ({ windowId: myWindowId, workspace: current() });
// Review requests start a workspace through the same new-workspace view as the + button.
const launcher = createLauncher({
  send,
  create(review) {
    creator.show(review);
    // The PR is what you came to look at, so it opens beside the workspace's other tabs, once.
    const { windowId, workspace } = here();
    void openInWorkspace(workspace, windowId, review.url);
  },
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
    }
    render();
  },
  here,
});
const git = createGitView({
  send,
  status: (id) => statuses[id] ?? null,
  onToggle() {
    if (git.isOpen) {
      creator.close();
      settings.close();
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
    }
    render();
  },
});
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
  }
  shownId = workspace?.id;
  git.setWorkspace(workspace);
  git.renderStatus();
  const overlay = creator.isOpen || git.isOpen || settings.isOpen;
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

function renderList(): void {
  if (editing || dragged) return;
  const here = current();
  listEl.replaceChildren(
    ...workspaces.map((ws, index) => {
      const item = document.createElement('li');
      item.className = `ws${ws.id === here?.id ? ' current' : ''}`;
      item.title = `${ws.name}\n${ws.cwd}${ws.groupId === null ? '' : '\nTab group'}`;

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(index + 1);
      const status = statuses[ws.id];
      if (status) badge.dataset.status = status;
      const groupColor = ws.groupId === null ? undefined : groupColors.get(ws.groupId);
      if (groupColor) badge.dataset.group = groupColor;

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

      item.append(badge, name, remove);
      item.addEventListener('click', () => {
        if (ws.id !== here?.id) openWorkspace(ws);
        else {
          creator.close();
          git.close();
        }
      });
      addDragHandlers(item, ws);
      return item;
    }),
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

  getHelper().then((helper) => {
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
      if (message.type === 'output') term.write(message.data);
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
  }, () => {
    // The control connection's notice explains the outage; the next state retries the attach.
    connecting = false;
    attachedId = null;
  });
}

term.onData((data) => sendToSession({ type: 'input', data }));

attachFileDrop(terminalEl, {
  send: (name, data) => sendToSession({ type: 'file', name, data }),
  notice: showNotice,
});

// xterm sends the same \r for Enter and Shift+Enter; Claude reads ESC + \r as a newline, as iTerm can be set to send.
term.attachCustomKeyEventHandler((event) => {
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

makeSectionsResizable(fitTerminal);

void chrome.windows.getCurrent().then((win) => {
  myWindowId = win.id;
  render();
});
