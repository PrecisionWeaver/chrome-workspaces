import { layoutGraph } from '../../shared/git-graph';
import type {
  BranchPr,
  ControlToClient,
  ControlToHelper,
  GitBranch,
  GitCommit,
  GitCommitFile,
  GitFile,
  GitState,
  Workspace,
  WorkspaceStatus,
} from '../../shared/protocol';
import { el } from './dom';
import { menuItem, openMenu } from './menu';
import { relative } from './pr-view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface GitViewOptions {
  send(message: ControlToHelper): boolean;
  /** Called when the diff view opens or closes, so the panel can swap it with the terminal. */
  onToggle(): void;
  /** What the workspace's claude is doing, from its status hooks. */
  status(id: string): WorkspaceStatus;
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
const MAX_DIFF_LINES = 4000;
const LANE_COLORS = ['#6fa3ff', '#4fcf8e', '#e5b84d', '#f26d6d', '#c58af9', '#78d9ec', '#fcad70', '#ff8bcb'];
const CELL = 12;
const ROW = 24;

const STATUS_TEXT: Record<NonNullable<WorkspaceStatus>, string> = {
  working: 'Claude is working',
  needs_input: 'Claude needs input',
  idle: 'Claude is idle',
};

const LETTER_TONE: Record<string, string> = { M: 'mod', A: 'add', U: 'add', D: 'del', R: 'ren', C: 'ren', T: 'mod' };

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
};

/** A file in a list: name, folder and status letter, with optional actions that show on hover. */
function fileRow(letter: string, path: string, from: string | undefined, onClick: () => void, fresh = false, actions: HTMLElement[] = []): HTMLElement {
  const row = el('div', '', `git-file${fresh ? ' fresh' : ''}`);
  row.tabIndex = 0;
  row.setAttribute('role', 'button');
  const slash = path.lastIndexOf('/');
  const name = el('span', path.slice(slash + 1), 'git-file-name');
  const dir = el('span', slash === -1 ? '' : path.slice(0, slash), 'git-file-dir');
  row.title = from ? `${from} → ${path}` : path;
  row.append(name, dir);
  if (actions.length) {
    const box = el('span', '', 'git-file-actions');
    box.append(...actions);
    box.addEventListener('click', (event) => event.stopPropagation());
    row.append(box);
  }
  row.append(el('span', letter, `git-letter ${LETTER_TONE[letter] ?? ''}`));
  row.addEventListener('click', onClick);
  row.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target === row) onClick();
  });
  return row;
}

/** A small button for a file or group; `armed` makes it ask twice, for something that cannot be undone. */
function iconButton(label: string, title: string, run: () => void, confirm?: string): HTMLButtonElement {
  const button = el('button', label, 'git-act');
  button.type = 'button';
  button.title = title;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!confirm || button.classList.contains('armed')) {
      run();
      return;
    }
    button.classList.add('armed');
    button.textContent = confirm;
    setTimeout(() => {
      button.classList.remove('armed');
      button.textContent = label;
    }, ARM_MS);
  });
  return button;
}

export function createGitView({ send, onToggle, status }: GitViewOptions): GitView {
  const section = $<HTMLElement>('git');
  const branchEl = $<HTMLDivElement>('git-branch');
  const errorEl = $<HTMLDivElement>('git-error');
  const changesEl = $<HTMLDivElement>('git-changes');
  const commitsEl = $<HTMLDivElement>('git-commits');
  const diffSection = $<HTMLElement>('diff');
  const diffTitle = $<HTMLHeadingElement>('diff-title');
  const diffMeta = $<HTMLDivElement>('diff-meta');
  const diffFiles = $<HTMLDivElement>('diff-files');
  const diffBody = $<HTMLDivElement>('diff-body');
  const saveBox = $<HTMLDivElement>('git-save');
  const messageInput = $<HTMLTextAreaElement>('git-message');
  const saveButton = $<HTMLButtonElement>('git-save-btn');
  const noticeEl = $<HTMLDivElement>('git-notice');
  const refreshButton = $<HTMLButtonElement>('git-refresh');

  let workspaceId: string | null = null;
  let state: GitState | null = null;
  let error: string | null = null;
  let loaded = false;
  // A status request is out; the refresh button waits for its answer.
  let refreshing = false;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  // Path → "XY" from the previous answer, to spot what changed since.
  let previous = new Map<string, string>();
  const fresh = new Set<string>();
  let freshTimer: ReturnType<typeof setTimeout> | undefined;

  // What the pane knows beyond status: the branch's pull request and its checks.
  let pr: { pr: BranchPr; checks: { passed: number; failed: number; pending: number; failing: string[] } | null } | null = null;
  let checksAt = 0;
  let checksBranch: string | null = null;
  let branches: GitBranch[] = [];
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  // A compare view is open: its files list, and each file's diff against the base.
  let comparing = false;

  let isOpen = false;
  let openSha: string | null = null;
  let openPath: string | null = null;

  const collapsed = () => section.classList.contains('collapsed');

  function setRefreshing(on: boolean): void {
    refreshing = on;
    refreshButton.disabled = on;
    clearTimeout(refreshTimer);
    // If the answer never comes (the helper restarted mid-request), do not leave the button dead.
    if (on) refreshTimer = setTimeout(() => setRefreshing(false), REFRESH_TIMEOUT_MS);
  }

  function refresh(): void {
    if (!workspaceId || collapsed() || refreshing) return;
    setRefreshing(true);
    send({ type: 'git', id: workspaceId });
    if (Date.now() - checksAt > CHECKS_MS) {
      checksAt = Date.now();
      send({ type: 'gitChecks', id: workspaceId });
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
    isOpen = false;
    comparing = false;
    openSha = openPath = null;
    diffSection.hidden = true;
  }

  function close(): void {
    if (!isOpen) return;
    closeQuietly();
    onToggle();
  }

  function renderStatus(): void {
    branchEl.replaceChildren();
    if (!workspaceId) return;
    if (state) {
      const branch = el('button', '', 'git-branch-name');
      branch.type = 'button';
      branch.title = 'Switch branch';
      branch.append(el('span', '⎇', 'git-branch-icon'), el('span', state.branch ?? 'detached HEAD'), el('span', '▾', 'git-branch-caret'));
      branch.addEventListener('click', () => openBranchMenu(branch));
      branchEl.append(branch);
      // Claude moves into worktrees on its own; say so when this is one, since it has its own branch and history.
      if (state.worktree) {
        const chip = el('span', `worktree · ${state.worktree}`, 'git-worktree');
        chip.title = `Claude is working in a linked worktree\n${state.root}`;
        branchEl.append(chip);
      }
      if (state.ahead) branchEl.append(el('span', `↑${state.ahead}`, 'git-sync'));
      if (state.behind) branchEl.append(el('span', `↓${state.behind}`, 'git-sync'));
      const compare = el('button', 'vs main', 'git-chip-btn');
      compare.type = 'button';
      compare.title = 'Everything this branch changes since it forked from its main branch';
      compare.addEventListener('click', openCompare);
      branchEl.append(compare);
      if (pr) {
        const { checks } = pr;
        const summary =
          !checks || checks.passed + checks.failed + checks.pending === 0
            ? ['no checks', '']
            : checks.failed
              ? [`✗ ${checks.failed} failing`, 'bad']
              : checks.pending
                ? [`● ${checks.pending} running`, 'wait']
                : [`✓ ${checks.passed} passing`, 'good'];
        const chip = el('button', `#${pr.pr.number}${pr.pr.isDraft ? ' draft' : ''} · ${summary[0]}`, `git-chip-btn ci ${summary[1]}`);
        chip.type = 'button';
        chip.title = `${pr.pr.title}${checks?.failing.length ? `\nFailing: ${checks.failing.join(', ')}` : ''}\nOpen on GitHub`;
        chip.addEventListener('click', () => void chrome.tabs.create({ url: pr!.pr.url }));
        branchEl.append(chip);
      }
    }
    const live = status(workspaceId);
    if (live) {
      const chip = el('span', STATUS_TEXT[live], 'git-claude');
      chip.dataset.status = live;
      branchEl.append(chip);
    }
  }

  function renderChanges(): void {
    changesEl.replaceChildren();
    if (!state) return;
    const staged = state.files.filter((f) => f.index !== ' ' && f.index !== '?');
    const unstaged = state.files.filter((f) => f.worktree !== ' ' || f.index === '?');
    const group = (title: string, files: GitFile[], letterOf: (f: GitFile) => string, all: HTMLElement[], each: (f: GitFile) => HTMLElement[]) => {
      if (files.length === 0) return;
      const heading = el('h3', title);
      heading.append(el('span', String(files.length), 'count'));
      const bulk = el('span', '', 'git-bulk');
      bulk.append(...all);
      heading.append(bulk);
      changesEl.append(heading, ...files.map((f) => fileRow(letterOf(f), f.path, f.from, () => openWorking(f.path), fresh.has(f.path), each(f))));
    };
    const stage = (paths: string[], on: boolean) => workspaceId && send({ type: 'gitStage', id: workspaceId, paths, stage: on });
    group(
      'Staged changes',
      staged,
      (f) => f.index,
      [iconButton('−', 'Unstage all', () => stage([], false))],
      (f) => [iconButton('−', 'Unstage', () => stage([f.path], false))],
    );
    group(
      'Changes',
      unstaged,
      (f) => (f.index === '?' ? 'U' : f.worktree),
      [iconButton('+', 'Stage all', () => stage([], true))],
      (f) => [
        iconButton(
          '↶',
          f.index === '?' ? 'Delete this new file' : 'Discard changes',
          () => workspaceId && send({ type: 'gitDiscard', id: workspaceId, paths: [f.path] }),
          f.index === '?' ? 'Delete?' : 'Discard?',
        ),
        iconButton('+', 'Stage', () => stage([f.path], true)),
      ],
    );
    if (state.files.length === 0) changesEl.append(el('div', 'Working tree clean', 'git-empty'));
    renderSave(staged.length);
  }

  function renderSave(stagedCount: number): void {
    // Kept once a message has been started, so staging another file does not take the box away.
    saveBox.hidden = stagedCount === 0 && !messageInput.value.trim();
    saveButton.disabled = stagedCount === 0 || !messageInput.value.trim();
    saveButton.title = stagedCount === 0 ? 'Stage something first' : `Commit ${stagedCount} staged file${stagedCount === 1 ? '' : 's'}`;
  }

  function commit(): void {
    if (!workspaceId || saveButton.disabled) return;
    send({ type: 'gitSave', id: workspaceId, message: messageInput.value });
    saveButton.disabled = true;
  }

  saveButton.addEventListener('click', commit);
  messageInput.addEventListener('input', () => renderSave(state?.files.filter((f) => f.index !== ' ' && f.index !== '?').length ?? 0));
  messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commit();
    }
  });

  // ---- branches ----

  function openBranchMenu(anchor: HTMLElement): void {
    if (!workspaceId) return;
    send({ type: 'gitBranches', id: workspaceId });
    const box = anchor.getBoundingClientRect();
    openMenu(box.left, box.bottom + 2, [el('div', 'Loading branches…', 'popup-note')], 'branch-menu');
  }

  function showBranches(): void {
    if (!document.querySelector('.branch-menu')) return;
    const anchor = branchEl.querySelector<HTMLElement>('.git-branch-name');
    const box = anchor?.getBoundingClientRect();
    openMenu(
      box?.left ?? 8,
      (box?.bottom ?? 40) + 2,
      branches.length
        ? branches.map((b) =>
            menuItem(b.name, () => workspaceId && send({ type: 'gitSwitch', id: workspaceId, branch: b.name }), {
              checked: b.current,
              disabled: b.current,
              title: b.upstream ? `tracks ${b.upstream}` : 'local only',
            }),
          )
        : [el('div', 'No branches', 'popup-note')],
      'branch-menu',
    );
  }

  function renderCommits(): void {
    commitsEl.replaceChildren();
    if (!state || state.commits.length === 0) return;
    const heading = el('h3', 'Commits');
    heading.append(el('span', String(state.commits.length), 'count'));
    const rows = layoutGraph(state.commits);
    const lanes = Math.max(1, ...rows.map((r) => r.width));
    commitsEl.append(
      heading,
      ...state.commits.map((commit, index) => {
        const { node, nodeColor, segments } = rows[index];
        const color = (i: number) => LANE_COLORS[i % LANE_COLORS.length];
        const graph = svg('svg', { width: lanes * CELL + 4, height: ROW, class: 'git-graph' });
        const x = (column: number) => column * CELL + CELL / 2 + 2;
        for (const s of segments)
          graph.append(svg('line', { x1: x(s.x1), y1: s.y1 * ROW, x2: x(s.x2), y2: s.y2 * ROW, stroke: color(s.color), 'stroke-width': 1.6 }));
        const dot = svg('circle', { cx: x(node), cy: ROW / 2, r: 4, stroke: color(nodeColor), 'stroke-width': 1.6 });
        // A merge is drawn hollow, in the list's own color so it reads on either theme.
        if (commit.parents.length > 1) dot.style.fill = 'var(--list-bg)';
        else dot.setAttribute('fill', color(nodeColor));
        graph.append(dot);

        const row = el('button', '', 'git-commit');
        row.type = 'button';
        row.title = `${commit.short} · ${commit.author} · ${new Date(commit.date).toLocaleString()}\n${commit.subject}`;
        const text = el('span', '', 'git-commit-text');
        text.append(el('span', commit.subject, 'git-subject'));
        if (commit.refs.length) {
          // The first ref is shown by name; any others fold into a count, so a small pane never fills with clipped pills.
          const refs = el('span', '', 'git-refs');
          const labels = commit.refs.map((ref) => ref.replace('HEAD -> ', ''));
          const toneOf = (ref: string) => (ref.startsWith('HEAD') ? ' head' : ref.startsWith('tag:') ? ' tag' : '');
          const first = el('span', labels[0], `git-ref${toneOf(commit.refs[0])}`);
          first.title = labels[0];
          refs.append(first);
          if (labels.length > 1) {
            const more = el('span', `+${labels.length - 1}`, 'git-ref more');
            more.title = labels.slice(1).join('\n');
            refs.append(more);
          }
          text.append(refs);
        }
        row.append(graph, text, el('span', relative(commit.date), 'git-when'));
        row.addEventListener('click', () => openCommit(commit));
        return row;
      }),
    );
  }

  function render(): void {
    errorEl.hidden = error === null;
    errorEl.textContent = error ?? '';
    renderStatus();
    renderChanges();
    renderCommits();
  }

  // ---- diff view ----

  function showDiffView(title: string, meta: string): void {
    diffTitle.textContent = title;
    diffMeta.textContent = meta;
    diffFiles.replaceChildren();
    diffFiles.hidden = true;
    diffBody.replaceChildren(el('div', 'Loading…', 'git-empty'));
    diffSection.hidden = false;
    const wasOpen = isOpen;
    isOpen = true;
    if (!wasOpen) onToggle();
  }

  function openWorking(path: string): void {
    if (!workspaceId) return;
    comparing = false;
    openSha = null;
    openPath = path;
    showDiffView(path, 'Working tree against HEAD');
    send({ type: 'gitDiff', id: workspaceId, path });
  }

  function openCommit(commit: GitCommit): void {
    if (!workspaceId) return;
    comparing = false;
    openSha = commit.sha;
    openPath = null;
    showDiffView(commit.subject, `${commit.short} · ${commit.author} · ${new Date(commit.date).toLocaleString()}`);
    send({ type: 'gitCommit', id: workspaceId, sha: commit.sha });
  }

  function openCompare(): void {
    if (!workspaceId) return;
    openSha = null;
    openPath = null;
    showDiffView(`${state?.branch ?? 'This branch'} vs main`, 'Everything this branch changes since it forked');
    comparing = true;
    send({ type: 'gitCompare', id: workspaceId });
  }

  function selectCommitFile(file: GitCommitFile): void {
    if (!workspaceId || (!openSha && !comparing)) return;
    openPath = file.path;
    for (const button of diffFiles.querySelectorAll<HTMLElement>('.git-file')) button.classList.toggle('selected', button.dataset.path === file.path);
    diffBody.replaceChildren(el('div', 'Loading…', 'git-empty'));
    send({ type: 'gitDiff', id: workspaceId, path: file.path, ...(openSha ? { sha: openSha } : { base: true }) });
  }

  function renderDiff(diff: string, truncated: boolean): void {
    if (!diff.trim()) {
      diffBody.replaceChildren(el('div', 'No textual changes (binary file, mode change or empty).', 'git-empty'));
      return;
    }
    const lines = diff.split('\n');
    const shown = lines.slice(0, MAX_DIFF_LINES);
    const fragment = document.createDocumentFragment();
    for (const line of shown) {
      const meta = /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(line);
      const kind = meta ? 'meta' : line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
      fragment.append(el('div', line || ' ', `diff-line ${kind}`));
    }
    if (truncated || lines.length > shown.length) fragment.append(el('div', 'Diff truncated.', 'git-empty'));
    diffBody.replaceChildren(fragment);
  }

  $<HTMLButtonElement>('diff-close').addEventListener('click', close);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen) close();
  });

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
      return isOpen;
    },
    close,
    refresh,
    renderStatus,
    setWorkspace(workspace) {
      const id = workspace?.id ?? null;
      if (id === workspaceId) return;
      workspaceId = id;
      state = null;
      error = null;
      pr = null;
      checksAt = 0;
      checksBranch = null;
      branches = [];
      noticeEl.hidden = true;
      messageInput.value = '';
      loaded = false;
      previous = new Map();
      fresh.clear();
      // The old workspace's answer will be ignored, so do not wait for it.
      setRefreshing(false);
      closeQuietly();
      render();
      refresh();
    },
    setState(message) {
      if (message.id !== workspaceId) return;
      setRefreshing(false);
      state = message.state;
      error = message.error;
      // A different branch has different checks, so ask again at once.
      if (state && state.branch !== checksBranch) {
        checksBranch = state.branch;
        pr = null;
        checksAt = 0;
        refresh();
      }
      if (state) {
        // After the first answer, a file whose status differs from the last answer is highlighted: it is what claude just touched.
        if (loaded) for (const f of state.files) if (previous.get(f.path) !== `${f.index}${f.worktree}`) fresh.add(f.path);
        previous = new Map(state.files.map((f) => [f.path, `${f.index}${f.worktree}`]));
        loaded = true;
        if (fresh.size) {
          clearTimeout(freshTimer);
          freshTimer = setTimeout(() => {
            fresh.clear();
            renderChanges();
          }, FRESH_MS);
        }
      }
      render();
    },
    setCommit(message) {
      if (message.id !== workspaceId || message.sha !== openSha) return;
      if (message.error) {
        diffBody.replaceChildren(el('div', `Could not read the commit: ${message.error}`, 'git-empty'));
        return;
      }
      diffFiles.hidden = message.files.length === 0;
      diffFiles.replaceChildren(
        ...message.files.map((file) => {
          const row = fileRow(file.status, file.path, file.from, () => selectCommitFile(file));
          row.dataset.path = file.path;
          return row;
        }),
      );
      if (message.files[0]) selectCommitFile(message.files[0]);
      else diffBody.replaceChildren(el('div', 'No files changed.', 'git-empty'));
    },
    setDiff(message) {
      if (message.id !== workspaceId || message.sha !== openSha || message.path !== openPath) return;
      if (message.error) diffBody.replaceChildren(el('div', `Could not read the diff: ${message.error}`, 'git-empty'));
      else renderDiff(message.diff, message.truncated);
    },
    setResult(message) {
      if (message.id !== workspaceId) return;
      showNotice(message.message, message.ok);
      if (message.ok && message.action === 'commit') messageInput.value = '';
      // What changed on disk shows at once, instead of at the next poll.
      if (message.ok) {
        checksAt = 0;
        refresh();
      } else renderSave(state?.files.filter((f) => f.index !== ' ' && f.index !== '?').length ?? 0);
    },
    setBranches(message) {
      if (message.id !== workspaceId) return;
      if (message.error) showNotice(`Could not list branches: ${message.error}`, false);
      branches = message.branches;
      showBranches();
    },
    setChecks(message) {
      if (message.id !== workspaceId) return;
      pr = message.pr ? { pr: message.pr, checks: message.checks } : null;
      // A failed lookup (gh signed out, offline) just shows no chip; it is not worth a banner on every poll.
      renderStatus();
    },
    setCompare(message) {
      if (message.id !== workspaceId || !comparing) return;
      if (message.error || !message.compare) {
        diffBody.replaceChildren(el('div', message.error ?? 'Nothing to compare.', 'git-empty'));
        return;
      }
      const { compare } = message;
      diffMeta.textContent = `${compare.ahead} commit${compare.ahead === 1 ? '' : 's'} ahead of ${compare.base} (forked at ${compare.mergeBase})`;
      diffFiles.hidden = compare.files.length === 0;
      diffFiles.replaceChildren(
        ...compare.files.map((file) => {
          const row = fileRow(file.status, file.path, file.from, () => selectCommitFile(file));
          row.dataset.path = file.path;
          return row;
        }),
      );
      if (compare.files[0]) selectCommitFile(compare.files[0]);
      else diffBody.replaceChildren(el('div', 'No differences from the main branch.', 'git-empty'));
    },
  };
}
