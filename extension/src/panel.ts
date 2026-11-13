import { SearchAddon } from '@xterm/addon-search';
import { ticketUrl } from '../../shared/lib/jira';
import type { ControlToClient, ReviewRequest, Workspace } from '../../shared/protocol/protocol';
import { createActivitySection } from './activity/activity-section';
import { followAppearance } from './app/appearance';
import { connectControl } from './app/helper-client';
import { loadSelection, onSelectionChange, select } from './background/selection';
import { noteReviewTab, openInWorkspace } from './background/tabs';
import { switchTo } from './background/windows';
import { createCreateView } from './create/create-view';
import { attachFileDrop } from './create/file-drop';
import { createSessionAttachment } from './panel/attach';
import { createMessageHandler } from './panel/messages';
import { createNotices } from './panel/notices';
import { createPaletteItems } from './panel/palette-items';
import { createPicker } from './panel/picker';
import { createPanelState } from './panel/state';
import { openPopout } from './popout/popout-window';
import { createSettingsView } from './settings/settings-view';
import { createGitView } from './source-control/git-view';
import { createLauncher } from './source-control/launcher';
import { createTerminalSearch } from './terminal/terminal-search';
import { createSessionTerminal, shiftEnterNewline } from './terminal/terminal-session';
import { terminalTheme } from './terminal/terminal-theme';
import { createToolView } from './terminal/tool-view';
import { followTabZoom } from './terminal/zoom';
import { $, installHoverTips } from './ui/dom';
import { createPalette } from './ui/palette';
import { makeSectionsResizable } from './ui/sections';
import { createListResizer } from './workspace-list/list-resizer';
import { createWorkspaceList } from './workspace-list/workspace-list';

const newButton = $<HTMLButtonElement>('new');
const pickerEl = $<HTMLElement>('picker');
const terminalEl = $<HTMLDivElement>('terminal');

const state = createPanelState();
const notices = createNotices();

const terminal = createSessionTerminal((message) => session.send(message));
const { term } = terminal;
const search = new SearchAddon();
term.loadAddon(search);
term.open(terminalEl);
const finder = createTerminalSearch(search, () => term.focus());
const session = createSessionAttachment({ terminal, terminalEl, windowId: () => state.windowId, showNotice: notices.show });

followAppearance((theme) => {
  term.options.theme = terminalTheme(theme);
  tools.setTheme(terminalTheme(theme));
});

// The views the handler routes to are built below, with the connection's own send.
let handleMessage: (message: ControlToClient) => void = () => {};
const control = connectControl(
  (message) => handleMessage(message),
  (connected) => (connected ? notices.show(null) : notices.showOffline()),
);
const send = control.send.bind(control);
const here = () => ({ windowId: state.windowId, workspace: state.current() });
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
  ticketLink: (ticket) => ticketUrl(state.jiraBase, ticket),
});
const git = createGitView({
  send,
  status: (id) => state.statuses[id] ?? null,
  waiting: (id) => state.waiting[id] ?? null,
  archive: (id) => send({ type: 'remove', id }),
  onToggle() {
    if (git.isOpen) {
      creator.close();
      settings.close();
      tools.close();
    }
    render();
  },
});
installHoverTips();

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

void loadSelection().then((loaded) => {
  state.selection = loaded;
  render();
});
onSelectionChange((changed) => {
  state.selection = changed;
  render();
});
chrome.tabs.onActivated.addListener(({ windowId }) => windowId === state.windowId && void state.followActiveTab());

// ---- list ----

// The workspace the last render showed; the views over the terminal belong to it.
let shownId: string | undefined;

function render(): void {
  workspaceList.render();
  launcher.renderReviews(state.reviews, state.workspaces);
  const workspace = state.current();
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
  if (workspace) session.attach(workspace);
  else {
    session.detach();
    if (!overlay) void picker.render();
  }
}

const workspaceList = createWorkspaceList({
  send,
  state: () => state,
  current: () => state.current(),
  windowId: () => state.windowId,
  ticketLink: (ticket) => ticketUrl(state.jiraBase, ticket),
  open: openWorkspace,
  openShell: (ws) => tools.showShell(ws),
  popOut: (ws) => void openPopout(ws.id),
  onReselect: () => {
    creator.close();
    git.close();
  },
  reorder: (next) => {
    state.workspaces = next;
  },
});

function openWorkspace(ws: Workspace): void {
  // Opening a panel needs a user gesture, so do it before anything awaits.
  if (ws.windowId !== null) chrome.sidePanel.open({ windowId: ws.windowId }).catch(() => {});
  void select(ws);
  void switchTo(ws, send, state.workspaces);
}

newButton.addEventListener('click', () => creator.show());

$<HTMLButtonElement>('collapse').addEventListener('click', () => {
  const collapsed = document.body.classList.toggle('collapsed');
  void chrome.storage.local.set({ listCollapsed: collapsed });
  session.fit();
});

const listResizer = createListResizer($<HTMLDivElement>('list-resizer'), session.fit);

void chrome.storage.local.get(['listCollapsed', 'listWidth']).then(({ listCollapsed, listWidth }) => {
  document.body.classList.toggle('collapsed', listCollapsed === true);
  if (typeof listWidth === 'number') listResizer.setWidth(listWidth);
  session.fit();
});

// ---- unpaired window ----

const picker = createPicker({ state, send });

// ---- terminal ----

attachFileDrop(terminalEl, {
  send: (name, data) => session.send({ type: 'file', name, data }),
  notice: notices.show,
});

term.attachCustomKeyEventHandler((event) => {
  // ⌘K / Ctrl+K is the palette's, even while the terminal has focus: the terminal ignores it, and the
  // same keypress then reaches the page-level handler below, which opens the palette. Opening it here as
  // well would open and immediately close it, so this only declines the key.
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') return false;
  // ⌘F / Ctrl+F likewise belongs to the find box.
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f') return false;
  return shiftEnterNewline(event, session.send);
});

new ResizeObserver(session.fit).observe(terminalEl);
// A pop-out can show the same session at another size; the last view in use sets the terminal's.
window.addEventListener('focus', session.fit);

handleMessage = createMessageHandler({
  state,
  views: { creator, git, settings, activity, workspaceList },
  session,
  showNotice: notices.show,
  render,
});

// Usage and resource warnings are checked every 15 seconds while the panel is open, so the header and the
// gear stay current; Settings itself polls faster while it is showing.
setInterval(() => {
  if (document.visibilityState === 'visible' && !settings.isOpen) send({ type: 'system' });
}, 15_000);
send({ type: 'system' });

const palette = createPalette(createPaletteItems({ state, send, creator, tools, activity, settings, git, workspaceList, openWorkspace, startReview }), () =>
  terminalEl.hidden ? undefined : term.focus(),
);
// Outside the terminal the same shortcut works anywhere in the panel.
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    if (palette.isOpen) palette.close();
    else palette.open();
  }
  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f' && !terminalEl.hidden) {
    event.preventDefault();
    finder.open();
  }
});

makeSectionsResizable(session.fit);

void chrome.windows.getCurrent().then((win) => {
  state.windowId = win.id;
  if (win.id !== undefined) followTabZoom(win.id);
  render();
});
