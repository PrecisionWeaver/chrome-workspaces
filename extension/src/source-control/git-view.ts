import type {
  BranchPr,
  ControlToClient,
  ControlToHelper,
  GitBranch,
  GitState,
  PrDetails,
  WaitingOn,
  Workspace,
  WorkspaceStatus,
} from '../../../shared/protocol/protocol';
import { $, type Arming, createArming, el, wireBack } from '../ui/dom';
import { commit, renderChanges, renderSave, stagedFiles } from './git-changes';
import { renderCommits, showBranches } from './git-commits';
import { listDiffFiles, renderDiff } from './git-diff';
import { renderStatus } from './git-status';

export interface GitViewOptions {
  send(message: ControlToHelper): boolean;
  /** Called when the diff view opens or closes, so the panel can swap it with the terminal. */
  onToggle(): void;
  /** What the workspace's claude is doing, from its status hooks. */
  status(id: string): WorkspaceStatus;
  /** What its claude waits on, while the status is `needs_input`. */
  waiting?(id: string): WaitingOn | null;
  /** Archives the workspace, offered once its pull request has merged. */
  archive?(id: string): void;
}

export interface GitView {
  /** Whether the diff view is showing. */
  readonly isOpen: boolean;
  close(): void;
  /** Points the accordion at the workspace in view; switching workspaces clears and reloads it. */
  setWorkspace(workspace: Workspace | undefined): void;
  refresh(): void;
  /** Redraws the line that says what claude is doing. */
  renderStatus(): void;
  setState(message: Extract<ControlToClient, { type: 'git' }>): void;
  setCommit(message: Extract<ControlToClient, { type: 'gitCommit' }>): void;
  setDiff(message: Extract<ControlToClient, { type: 'gitDiff' }>): void;
  setResult(message: Extract<ControlToClient, { type: 'gitResult' }>): void;
  setBranches(message: Extract<ControlToClient, { type: 'gitBranches' }>): void;
  setChecks(message: Extract<ControlToClient, { type: 'gitChecks' }>): void;
  setCompare(message: Extract<ControlToClient, { type: 'gitCompare' }>): void;
}

/**
 * What the panes share: the section's elements, the view's state and the way back into the view. A pane
 * (`git-status`, `git-changes`, `git-commits`, `git-diff`) draws its part of the DOM from this and writes
 * state back through it; the view owns the polling, the notices and the workspace it points at.
 */
export interface GitViewContext extends GitViewOptions {
  readonly branchEl: HTMLDivElement;
  readonly changesEl: HTMLDivElement;
  readonly commitsEl: HTMLDivElement;
  readonly diffSection: HTMLElement;
  readonly diffTitle: HTMLHeadingElement;
  readonly diffMeta: HTMLDivElement;
  readonly diffFiles: HTMLDivElement;
  readonly diffBody: HTMLDivElement;
  readonly saveBox: HTMLDivElement;
  readonly messageInput: HTMLTextAreaElement;
  readonly saveButton: HTMLButtonElement;

  workspaceId: string | null;
  state: GitState | null;
  /** What the pane knows beyond status: the branch's pull request and its checks. */
  pr: { pr: BranchPr; checks: PrDetails['checks'] | null } | null;
  /** The branch the last checks answer was for; a lookup that found no PR means one can be made. */
  checksBranch: string | null;
  /** A push or pull request under way, so its button is not pressed twice. */
  pushing: boolean;
  branches: GitBranch[];
  /** Files whose status changed since the last answer, highlighted for a while. */
  readonly fresh: Set<string>;
  /** Discard and archive ask twice; the first click stays armed through the polls that redraw them. */
  readonly arming: Arming;
  /** A compare view is open: its files list, and each file's diff against the base. */
  comparing: boolean;
  isOpen: boolean;
  openSha: string | null;
  openPath: string | null;
  /** The card listing every ref of the commit under the pointer; at most one, and gone when the list is redrawn. */
  refCard: HTMLElement | null;
  /** Redraws the whole section. */
  render(): void;
}

const POLL_MS = 5000;
// The longest the refresh button waits for a status answer before it frees itself.
const REFRESH_TIMEOUT_MS = 30_000;
// CI changes slowly and each check is a call to GitHub, so it is asked about less often than status.
const CHECKS_MS = 60_000;
// A discard button asks twice; it disarms after this long.
const ARM_MS = 3000;
const NOTICE_MS = 6000;
// How long a file that just changed stays highlighted.
const FRESH_MS = 5000;

export function createGitView(options: GitViewOptions): GitView {
  const section = $<HTMLElement>('git');
  const errorEl = $<HTMLDivElement>('git-error');
  const noticeEl = $<HTMLDivElement>('git-notice');
  const refreshButton = $<HTMLButtonElement>('git-refresh');

  let error: string | null = null;
  let loaded = false;
  // A status request is out; the refresh button waits for its answer.
  let refreshing = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  // Path → "XY" from the previous answer, to spot what changed since.
  let previous = new Map<string, string>();
  let freshTimer: ReturnType<typeof setTimeout> | undefined;
  let checksAt = 0;
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;

  const ctx: GitViewContext = {
    ...options,
    branchEl: $<HTMLDivElement>('git-branch'),
    changesEl: $<HTMLDivElement>('git-changes'),
    commitsEl: $<HTMLDivElement>('git-commits'),
    diffSection: $<HTMLElement>('diff'),
    diffTitle: $<HTMLHeadingElement>('diff-title'),
    diffMeta: $<HTMLDivElement>('diff-meta'),
    diffFiles: $<HTMLDivElement>('diff-files'),
    diffBody: $<HTMLDivElement>('diff-body'),
    saveBox: $<HTMLDivElement>('git-save'),
    messageInput: $<HTMLTextAreaElement>('git-message'),
    saveButton: $<HTMLButtonElement>('git-save-btn'),
    workspaceId: null,
    state: null,
    pr: null,
    checksBranch: null,
    pushing: false,
    branches: [],
    fresh: new Set(),
    arming: createArming(() => render(), ARM_MS),
    comparing: false,
    isOpen: false,
    openSha: null,
    openPath: null,
    refCard: null,
    render,
  };

  const collapsed = () => section.classList.contains('collapsed');

  function setRefreshing(on: boolean): void {
    refreshing = on;
    refreshButton.disabled = on;
    clearTimeout(refreshTimer);
    // If the answer never comes (the helper restarted mid-request), do not leave the button dead.
    if (on) refreshTimer = setTimeout(() => setRefreshing(false), REFRESH_TIMEOUT_MS);
  }

  function refresh(): void {
    if (!ctx.workspaceId || collapsed() || refreshing) return;
    setRefreshing(true);
    ctx.send({ type: 'git', id: ctx.workspaceId });
    if (Date.now() - checksAt > CHECKS_MS) {
      checksAt = Date.now();
      ctx.send({ type: 'gitChecks', id: ctx.workspaceId });
    }
  }

  function showNotice(text: string, ok: boolean): void {
    noticeEl.hidden = false;
    noticeEl.className = ok ? 'ok' : 'bad';
    noticeEl.textContent = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (noticeEl.hidden = true), NOTICE_MS);
  }

  function closeQuietly(): void {
    ctx.isOpen = false;
    ctx.comparing = false;
    ctx.openSha = ctx.openPath = null;
    ctx.diffSection.hidden = true;
  }

  function close(): void {
    if (!ctx.isOpen) return;
    closeQuietly();
    ctx.onToggle();
  }

  function render(): void {
    errorEl.hidden = error === null;
    errorEl.textContent = error ?? '';
    renderStatus(ctx);
    renderChanges(ctx);
    renderCommits(ctx);
  }

  ctx.saveButton.addEventListener('click', () => commit(ctx));
  ctx.messageInput.addEventListener('input', () => renderSave(ctx, stagedFiles(ctx.state).length));
  ctx.messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit(ctx);
    }
  });

  wireBack('diff-close', close, () => ctx.isOpen);

  // ---- accordion ----

  $<HTMLButtonElement>('git-toggle').addEventListener('click', () => {
    const nowCollapsed = section.classList.toggle('collapsed');
    void chrome.storage.local.set({ gitCollapsed: nowCollapsed });
    if (!nowCollapsed) refresh();
  });
  refreshButton.addEventListener('click', refresh);
  void chrome.storage.local.get('gitCollapsed').then(({ gitCollapsed }) => {
    section.classList.toggle('collapsed', gitCollapsed === true);
    refresh();
  });

  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);

  return {
    get isOpen() {
      return ctx.isOpen;
    },
    close,
    refresh,
    renderStatus: () => renderStatus(ctx),
    setWorkspace(workspace) {
      const id = workspace?.id ?? null;
      if (id === ctx.workspaceId) return;
      ctx.workspaceId = id;
      ctx.state = null;
      error = null;
      ctx.pr = null;
      checksAt = 0;
      ctx.checksBranch = null;
      ctx.pushing = false;
      ctx.arming.clear();
      ctx.branches = [];
      noticeEl.hidden = true;
      ctx.messageInput.value = '';
      loaded = false;
      previous = new Map();
      ctx.fresh.clear();
      // The old workspace's answer will be ignored, so do not wait for it.
      setRefreshing(false);
      closeQuietly();
      render();
      refresh();
    },
    setState(message) {
      if (message.id !== ctx.workspaceId) return;
      setRefreshing(false);
      const { state } = message;
      ctx.state = state;
      error = message.error;
      // A different branch has different checks, so ask again at once.
      if (state && state.branch !== ctx.checksBranch) {
        ctx.checksBranch = state.branch;
        ctx.pr = null;
        checksAt = 0;
        refresh();
      }
      if (state) {
        // After the first answer, a file whose status differs from the last answer is highlighted: it is what claude just touched.
        if (loaded) for (const f of state.files) if (previous.get(f.path) !== `${f.index}${f.worktree}`) ctx.fresh.add(f.path);
        previous = new Map(state.files.map((f) => [f.path, `${f.index}${f.worktree}`]));
        loaded = true;
        if (ctx.fresh.size) {
          clearTimeout(freshTimer);
          freshTimer = setTimeout(() => {
            ctx.fresh.clear();
            renderChanges(ctx);
          }, FRESH_MS);
        }
      }
      render();
    },
    setCommit(message) {
      if (message.id !== ctx.workspaceId || message.sha !== ctx.openSha) return;
      if (message.error) {
        ctx.diffBody.replaceChildren(el('div', `Could not read the commit: ${message.error}`, 'git-empty'));
        return;
      }
      listDiffFiles(ctx, message.files, 'No files changed.');
    },
    setDiff(message) {
      if (message.id !== ctx.workspaceId || message.sha !== ctx.openSha || message.path !== ctx.openPath) return;
      if (message.error) ctx.diffBody.replaceChildren(el('div', `Could not read the diff: ${message.error}`, 'git-empty'));
      else renderDiff(ctx, message.diff, message.truncated);
    },
    setResult(message) {
      if (message.id !== ctx.workspaceId) return;
      showNotice(message.message, message.ok);
      if (message.ok && message.action === 'commit') ctx.messageInput.value = '';
      if (message.action === 'push' || message.action === 'pr') {
        ctx.pushing = false;
        if (message.ok && message.url) void chrome.tabs.create({ url: message.url });
        renderStatus(ctx);
      }
      // What changed on disk shows at once, instead of at the next poll.
      if (message.ok) {
        checksAt = 0;
        refresh();
      } else renderSave(ctx, stagedFiles(ctx.state).length);
    },
    setBranches(message) {
      if (message.id !== ctx.workspaceId) return;
      if (message.error) showNotice(`Could not list branches: ${message.error}`, false);
      ctx.branches = message.branches;
      showBranches(ctx);
    },
    setChecks(message) {
      if (message.id !== ctx.workspaceId) return;
      ctx.pr = message.pr ? { pr: message.pr, checks: message.checks } : null;
      // A failed lookup (gh signed out, offline) just shows no chip; it is not worth a banner on every poll.
      renderStatus(ctx);
    },
    setCompare(message) {
      if (message.id !== ctx.workspaceId || !ctx.comparing) return;
      if (message.error || !message.compare) {
        ctx.diffBody.replaceChildren(el('div', message.error ?? 'Nothing to compare.', 'git-empty'));
        return;
      }
      const { compare } = message;
      ctx.diffMeta.textContent = `${compare.ahead} commit${compare.ahead === 1 ? '' : 's'} ahead of ${compare.base} (forked at ${compare.mergeBase})`;
      listDiffFiles(ctx, compare.files, 'No differences from the main branch.');
    },
  };
}
