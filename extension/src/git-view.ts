import { layoutGraph } from '../../shared/git-graph';
import type { ControlToClient, ControlToHelper, GitCommit, GitCommitFile, GitFile, GitState, Workspace, WorkspaceStatus } from '../../shared/protocol';
import { el } from './dom';
import { relative } from './pr-view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface GitViewOptions {
  send(message: ControlToHelper): boolean;
  /** Called when the diff view opens or closes, so the panel can swap it with the terminal. */
  onToggle(): void;
  /** What the workspace's claude is doing, from Mission Control. */
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
}

const POLL_MS = 5000;
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

function fileRow(letter: string, path: string, from: string | undefined, onClick: () => void, fresh = false): HTMLElement {
  const row = el('button', '', `git-file${fresh ? ' fresh' : ''}`);
  row.type = 'button';
  const slash = path.lastIndexOf('/');
  const name = el('span', path.slice(slash + 1), 'git-file-name');
  const dir = el('span', slash === -1 ? '' : path.slice(0, slash), 'git-file-dir');
  row.title = from ? `${from} → ${path}` : path;
  row.append(name, dir, el('span', letter, `git-letter ${LETTER_TONE[letter] ?? ''}`));
  row.addEventListener('click', onClick);
  return row;
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

  let workspaceId: string | null = null;
  let state: GitState | null = null;
  let error: string | null = null;
  let loaded = false;
  // Path → "XY" from the previous answer, to spot what changed since.
  let previous = new Map<string, string>();
  const fresh = new Set<string>();
  let freshTimer: ReturnType<typeof setTimeout> | undefined;

  let isOpen = false;
  let openSha: string | null = null;
  let openPath: string | null = null;

  const collapsed = () => section.classList.contains('collapsed');

  function refresh(): void {
    if (workspaceId && !collapsed()) send({ type: 'git', id: workspaceId });
  }

  function closeQuietly(): void {
    isOpen = false;
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
      const branch = el('span', '', 'git-branch-name');
      branch.append(el('span', '⎇', 'git-branch-icon'), el('span', state.branch ?? 'detached HEAD'));
      branchEl.append(branch);
      if (state.ahead) branchEl.append(el('span', `↑${state.ahead}`, 'git-sync'));
      if (state.behind) branchEl.append(el('span', `↓${state.behind}`, 'git-sync'));
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
    const group = (title: string, files: GitFile[], letterOf: (f: GitFile) => string) => {
      if (files.length === 0) return;
      const heading = el('h3', title);
      heading.append(el('span', String(files.length), 'count'));
      changesEl.append(heading, ...files.map((f) => fileRow(letterOf(f), f.path, f.from, () => openWorking(f.path), fresh.has(f.path))));
    };
    group('Staged changes', staged, (f) => f.index);
    group('Changes', unstaged, (f) => (f.index === '?' ? 'U' : f.worktree));
    if (state.files.length === 0) changesEl.append(el('div', 'Working tree clean', 'git-empty'));
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
        for (const s of segments) graph.append(svg('line', { x1: x(s.x1), y1: s.y1 * ROW, x2: x(s.x2), y2: s.y2 * ROW, stroke: color(s.color), 'stroke-width': 1.6 }));
        graph.append(svg('circle', { cx: x(node), cy: ROW / 2, r: 4, fill: commit.parents.length > 1 ? '#18191d' : color(nodeColor), stroke: color(nodeColor), 'stroke-width': 1.6 }));

        const row = el('button', '', 'git-commit');
        row.type = 'button';
        row.title = `${commit.short} · ${commit.author} · ${new Date(commit.date).toLocaleString()}\n${commit.subject}`;
        const text = el('span', '', 'git-commit-text');
        text.append(el('span', commit.subject, 'git-subject'));
        for (const ref of commit.refs) text.append(el('span', ref.replace('HEAD -> ', ''), `git-ref${ref.startsWith('HEAD') ? ' head' : ref.startsWith('tag:') ? ' tag' : ''}`));
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
    openSha = null;
    openPath = path;
    showDiffView(path, 'Working tree against HEAD');
    send({ type: 'gitDiff', id: workspaceId, path });
  }

  function openCommit(commit: GitCommit): void {
    if (!workspaceId) return;
    openSha = commit.sha;
    openPath = null;
    showDiffView(commit.subject, `${commit.short} · ${commit.author} · ${new Date(commit.date).toLocaleString()}`);
    send({ type: 'gitCommit', id: workspaceId, sha: commit.sha });
  }

  function selectCommitFile(file: GitCommitFile): void {
    if (!workspaceId || !openSha) return;
    openPath = file.path;
    for (const button of diffFiles.querySelectorAll<HTMLElement>('.git-file')) button.classList.toggle('selected', button.dataset.path === file.path);
    diffBody.replaceChildren(el('div', 'Loading…', 'git-empty'));
    send({ type: 'gitDiff', id: workspaceId, path: file.path, sha: openSha });
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
  $<HTMLButtonElement>('git-refresh').addEventListener('click', refresh);
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
      loaded = false;
      previous = new Map();
      fresh.clear();
      closeQuietly();
      render();
      refresh();
    },
    setState(message) {
      if (message.id !== workspaceId) return;
      state = message.state;
      error = message.error;
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
  };
}
