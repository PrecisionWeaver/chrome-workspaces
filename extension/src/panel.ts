import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { similarity } from '../../shared/pairing';
import type { ClientMessage, HistoryEntry, ReviewRequest, ReviewsState, ServerMessage, Workspace, WorkspaceStatus } from '../../shared/protocol';
import { $, el } from './dom';
import { connectControl, getHelper, isHostMissing, openSocket, startHelper } from './helper-client';
import { createActivitySection } from './activity-section';
import { createCreateView } from './create-view';
import { attachFileDrop } from './file-drop';
import { createGitView } from './git-view';
import { resolveTheme } from '../../shared/keynav';
import { ticketUrl } from '../../shared/jira';
import { loadPrefs, onPrefsChange, type Prefs } from './prefs';
import { createPalette, type PaletteItem } from './palette';
import { createToolView } from './tool-view';
import { createSettingsView } from './settings-view';
import { makeSectionsResizable } from './sections';
import { noteReviewTab, openInWorkspace } from './tabs';
import { createLauncher } from './launcher';
import { createListResizer } from './list-resizer';
import { createWorkspaceList } from './workspace-list';
import { terminalTheme } from './terminal-theme';
import { loadSelection, onSelectionChange, select, shownIn, type Selection } from './selection';
import { showOnly, switchTo } from './windows';

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

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let appearance: Prefs | null = null;

/** Applies the theme and density to the page and the terminal; `system` follows the operating system. */
function applyAppearance(prefs: Prefs | null = appearance): void {
  if (!prefs) return;
  appearance = prefs;
  const theme = resolveTheme(prefs.theme, systemDark.matches);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.density = prefs.density;
  term.options.theme = terminalTheme(theme);
  tools.setTheme(terminalTheme(theme));
}
void loadPrefs().then(applyAppearance);
onPrefsChange(applyAppearance);
systemDark.addEventListener('change', () => applyAppearance());

let myWindowId: number | undefined;
let workspaces: Workspace[] = [];
let statuses: Record<string, WorkspaceStatus> = {};
let reviews: ReviewsState = { items: [], error: null, fetchedAt: null, refreshing: false };
let history: HistoryEntry[] = [];
// The Jira site from the config, learned from the system snapshot; null hides every ticket link.
let jiraBase: string | null = null;

const control = connectControl(
  (message) => {
    if (message.type === 'prompts') creator.setPrompts(message.prompts, message.error);
    if (message.type === 'repos') creator.setRepos(message.repos);
    if (message.type === 'history') {
      history = message.entries;
      workspaceList.render();
    }
    if (message.type === 'timeline') settings.setTimeline(message);
    if (message.type === 'activity') activity.setActivity(message);
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
/** Opens the new-workspace view for a review request, and its PR in a normal tab outside the current workspace's group. */
function startReview(review: ReviewRequest): void {
  creator.show(review);
  // The PR is what you came to look at, so it opens once, as a plain tab beside the current workspace's group rather than in it.
  // A tab opened here moves to the PR's workspace when one is made from this view.
  const { windowId, workspace } = here();
  void openInWorkspace(workspace?.groupId == null ? workspace : undefined, windowId, review.url).then((tabId) => {
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
      tools.close();
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
      tools.close();
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
      tools.close();
    }
    render();
  },
});
const tools = createToolView({
  onToggle() {
    if (tools.isOpen) {
      creator.close();
      git.close();
      settings.close();
    }
    render();
  },
});
const activity = createActivitySection({ send });
for (const [id, tool] of [
  ['monitor-open', 'monitor'],
  ['shell-open', 'shell'],
] as const) {
  $<HTMLButtonElement>(id).addEventListener('click', () => (tools.current === tool ? tools.close() : tools.show(tool)));
}
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

function showNotice(text: string | null): void {
  noticeEl.hidden = text === null;
  noticeEl.textContent = text ?? '';
}

const INSTALL_COMMAND = 'npm run install-app';

// Chrome finds no native host until install-app has registered it, so there is nothing for Start helper to start.
function showInstallNotice(): void {
  const copy = el('button', 'Copy command', 'notice-action');
  copy.type = 'button';
  copy.onclick = () => {
    void navigator.clipboard.writeText(INSTALL_COMMAND);
    copy.textContent = 'Copied';
  };
  noticeEl.hidden = false;
  noticeEl.replaceChildren(el('span', `The helper is not installed. In the chrome-workspaces folder, run ${INSTALL_COMMAND}, then restart Chrome.`), copy);
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
      if (isHostMissing(error)) return showInstallNotice();
      message.textContent = `Could not start the helper: ${error instanceof Error ? error.message : String(error)}. Try npm run agent:start.`;
      start.disabled = false;
    });
  };
  noticeEl.hidden = false;
  noticeEl.replaceChildren(message, start);
  // A helper that was never installed is not "not running"; say so up front.
  getHelper().catch((error) => {
    if (isHostMissing(error) && noticeEl.contains(message)) showInstallNotice();
  });
}

// ---- list ----

// The workspace the last render showed; the views over the terminal belong to it.
let shownId: string | undefined;

function render(): void {
  workspaceList.render();
  launcher.renderReviews(reviews, workspaces);
  const workspace = current();
  // Switching workspaces returns to the terminal: the new-workspace, review and diff views are left behind.
  if (shownId !== undefined && workspace?.id !== shownId) {
    shownId = workspace?.id;
    creator.close();
    git.close();
    settings.close();
    tools.close();
  }
  shownId = workspace?.id;
  git.setWorkspace(workspace);
  git.renderStatus();
  activity.setWorkspace(workspace);
  const overlay = creator.isOpen || git.isOpen || settings.isOpen || tools.isOpen;
  pickerEl.hidden = overlay || workspace !== undefined;
  terminalEl.hidden = overlay || workspace === undefined;
  if (workspace) attach(workspace);
  else {
    detach();
    if (!overlay) void renderPicker();
  }
}

const workspaceList = createWorkspaceList({
  send,
  state: () => ({ workspaces, statuses, history }),
  current,
  windowId: () => myWindowId,
  ticketLink: (ticket) => ticketUrl(jiraBase, ticket),
  open: openWorkspace,
  onReselect: () => {
    creator.close();
    git.close();
  },
  reorder: (next) => {
    workspaces = next;
  },
});

function openWorkspace(ws: Workspace): void {
  // Opening a panel needs a user gesture, so do it before anything awaits.
  if (ws.windowId !== null) chrome.sidePanel.open({ windowId: ws.windowId }).catch(() => {});
  void select(ws);
  void switchTo(ws, send, workspaces);
}

newButton.addEventListener('click', () => creator.show());

$<HTMLButtonElement>('collapse').addEventListener('click', () => {
  const collapsed = document.body.classList.toggle('collapsed');
  void chrome.storage.local.set({ listCollapsed: collapsed });
  fitTerminal();
});

const listResizer = createListResizer($<HTMLDivElement>('list-resizer'), fitTerminal);

void chrome.storage.local.get(['listCollapsed', 'listWidth']).then(({ listCollapsed, listWidth }) => {
  document.body.classList.toggle('collapsed', listCollapsed === true);
  if (typeof listWidth === 'number') listResizer.setWidth(listWidth);
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
    { kind: 'Action', label: 'Terminal', hint: 'A plain shell, not tied to a workspace', run: () => tools.show('shell') },
    { kind: 'Action', label: 'System monitor', hint: 'btop, in the panel', run: () => tools.show('monitor') },
    { kind: 'Action', label: 'Expand activity', hint: "What this workspace's claude is doing, turn by turn", run: () => activity.expand() },
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
      kind: 'Workspace',
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
      run: () => workspaceList.restore(entry),
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
