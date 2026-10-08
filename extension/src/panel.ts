import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { similarity, workspaceOrder } from '../../shared/pairing';
import type { ClientMessage, ReviewsState, ServerMessage, Workspace, WorkspaceStatus } from '../../shared/protocol';
import { connectControl, getHelper, openSocket } from './helper-client';
import { createLauncher } from './launcher';
import { switchTo } from './windows';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const listEl = $<HTMLUListElement>('workspaces');
const newButton = $<HTMLButtonElement>('new');
const newForm = $<HTMLFormElement>('new-form');
const newName = $<HTMLInputElement>('new-name');
const newMenu = $<HTMLDivElement>('new-menu');
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
    if (message.type === 'prompts') launcher.setPrompts(message.prompts, message.error);
    if (message.type === 'prDetails') launcher.setPrDetails(message.url, message.details, message.error);
    if (message.type !== 'state') return;
    workspaces = workspaceOrder(message.workspaces);
    statuses = message.statuses;
    reviews = message.reviews;
    render();
  },
  (connected) => showNotice(connected ? null : 'Helper not running. Start it with: npm run agent:start'),
);
const send = control.send.bind(control);
const launcher = createLauncher({ send, onToggle: render, openWorkspace });

function current(): Workspace | undefined {
  return workspaces.find((ws) => ws.windowId === myWindowId);
}

function showNotice(text: string | null): void {
  noticeEl.hidden = text === null;
  noticeEl.textContent = text ?? '';
}

// ---- list ----

function render(): void {
  renderList();
  launcher.renderReviews(reviews, workspaces);
  const workspace = current();
  pickerEl.hidden = launcher.isOpen || workspace !== undefined;
  terminalEl.hidden = launcher.isOpen || workspace === undefined;
  if (workspace) attach(workspace);
  else {
    detach();
    if (!launcher.isOpen) void renderPicker();
  }
}

// While a name is being edited the list isn't redrawn (status updates arrive constantly and
// would discard the input); it catches up when editing ends.
let editing = false;

function renderList(): void {
  if (editing) return;
  const here = current();
  listEl.replaceChildren(
    ...workspaces.map((ws, index) => {
      const item = document.createElement('li');
      item.className = `ws${ws.id === here?.id ? ' current' : ''}`;
      item.title = `${ws.name}\n${ws.cwd}`;

      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(index + 1);
      const status = statuses[ws.id];
      if (status) badge.dataset.status = status;

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
        else if (launcher.isOpen) launcher.close();
      });
      return item;
    }),
  );
}

function openWorkspace(ws: Workspace): void {
  // Opening a panel needs a user gesture, so do it before anything awaits.
  if (ws.windowId !== null) chrome.sidePanel.open({ windowId: ws.windowId }).catch(() => {});
  void switchTo(ws, send);
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

newButton.addEventListener('click', () => {
  newMenu.hidden = !newMenu.hidden;
});

$<HTMLButtonElement>('new-blank').addEventListener('click', () => {
  newMenu.hidden = true;
  newForm.hidden = false;
  newName.focus();
});

$<HTMLButtonElement>('new-prompt').addEventListener('click', () => {
  newMenu.hidden = true;
  launcher.show(null);
});

newName.addEventListener('blur', () => {
  newForm.hidden = true;
  newName.value = '';
});

newForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const name = newName.value.trim();
  if (name) send({ type: 'create', name, windowId: null });
  newName.blur();
});

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

function sendToSession(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
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

function fitTerminal(): void {
  if (terminalEl.hidden) return;
  fit.fit();
  sendToSession({ type: 'resize', cols: term.cols, rows: term.rows });
}

new ResizeObserver(fitTerminal).observe(terminalEl);

void chrome.windows.getCurrent().then((win) => {
  myWindowId = win.id;
  render();
});
