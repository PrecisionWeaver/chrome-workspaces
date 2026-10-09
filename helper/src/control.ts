import { isAbsolute } from 'node:path';
import type { WebSocket } from 'ws';
import { MAX_PROMPT_LENGTH, MAX_TAB_URLS, MODEL_PATTERN, type ControlToClient, type ControlToHelper, type Prompt, type Repo, type ReviewsState, type Workspace, type WorkspaceStatus } from '../../shared/protocol';
import { isDirectory } from './config';
import type { AdminService } from './admin';
import type { GitService } from './git';
import { parsePrDetails } from './pr-details';
import { isPullRequestUrl, prWorkspace } from './pr-workspace';
import type { SessionManager } from './session';
import type { WorkspaceStore } from './workspace-store';

export interface ReviewSource {
  state(): ReviewsState;
  refresh(): Promise<void>;
}

export interface ControlHubOptions {
  store: WorkspaceStore;
  sessions: SessionManager;
  defaultCwd: string;
  statuses: () => Record<string, WorkspaceStatus>;
  reviews: ReviewSource;
  /** Throws when the prompts file cannot be read. */
  prompts: () => Prompt[];
  /** Raw `gh pr view` JSON for a PR url. */
  prDetails: (url: string) => Promise<string>;
  repoDirs: Record<string, string>;
  repos: () => Repo[];
  git: GitService;
  admin: AdminService;
  /** The directory a workspace's claude last reported working in, if it has reported one. */
  workingDir: (id: string) => string | null;
}

/** Keeps every connected extension context (service worker, panels) in sync with the store. */
export class ControlHub {
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly options: ControlHubOptions) {
    options.store.onChange(() => this.broadcastState());
  }

  get clientCount(): number {
    return this.clients.size;
  }

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('message', (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (isControlToHelper(message)) this.handle(message, ws);
    });
    this.sendTo(ws, this.state());
  }

  /** Returns whether any extension context received it. */
  send(message: ControlToClient): boolean {
    for (const ws of this.clients) this.sendTo(ws, message);
    return this.clients.size > 0;
  }

  broadcastState(): void {
    this.send(this.state());
  }

  private state(): ControlToClient {
    const { store, statuses, reviews } = this.options;
    return { type: 'state', workspaces: store.list(), statuses: statuses(), reviews: reviews.state() };
  }

  private prompts(): ControlToClient {
    try {
      return { type: 'prompts', prompts: this.options.prompts(), error: null };
    } catch (error) {
      return { type: 'prompts', prompts: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  private handle(message: ControlToHelper, ws: WebSocket): void {
    const { store } = this.options;
    switch (message.type) {
      case 'pair':
        if (store.get(message.id)) store.pairWindow(message.id, message.windowId, message.groupId ?? null);
        break;
      case 'unpair':
        store.unpairWindow(message.windowId);
        break;
      case 'unpairGroup':
        store.unpairGroup(message.groupId);
        break;
      case 'tabs':
        store.setTabs(message.windowId, message.urls, message.groupId ?? null);
        break;
      case 'create': {
        const existing = message.pr ? store.findByPr(message.pr) : undefined;
        if (existing) {
          this.send({ type: 'focus', id: existing.id });
          break;
        }
        const { defaultCwd, repoDirs, reviews } = this.options;
        const chosen = message.cwd && isAbsolute(message.cwd) && isDirectory(message.cwd) ? message.cwd : null;
        // A PR workspace starts in its repo's configured directory unless one was picked.
        const base = message.pr ? prWorkspace(message.pr, { reviews: reviews.state().items, repoDirs, defaultCwd }) : { cwd: defaultCwd };
        if (chosen) base.cwd = chosen;
        const workspace = store.create({
          ...base,
          name: message.name.trim(),
          prompt: message.prompt?.trim() || null,
          model: message.model ?? null,
          tabs: message.urls ?? [],
        });
        if (message.windowId === null) this.send({ type: 'open', id: workspace.id });
        else {
          store.pairWindow(workspace.id, message.windowId);
          // A workspace joining a window another one holds gets its own tab group there.
          if (message.group) this.send({ type: 'group', id: workspace.id });
        }
        break;
      }
      case 'rename':
        if (store.get(message.id)) store.rename(message.id, message.name.trim());
        break;
      case 'move':
        if (store.get(message.id)) store.move(message.id, message.index);
        break;
      case 'order':
        store.reorder(message.ids);
        break;
      case 'remove':
        this.options.sessions.remove(message.id);
        store.remove(message.id);
        break;
      case 'listPrompts':
        this.sendTo(ws, this.prompts());
        break;
      case 'system':
        this.options.admin.snapshot({ reviews: this.options.reviews.state(), clients: this.clients.size }).then(
          (snapshot) => this.sendTo(ws, { type: 'system', snapshot, error: null }),
          (error: unknown) => this.sendTo(ws, { type: 'system', snapshot: null, error: error instanceof Error ? error.message : String(error) }),
        );
        break;
      case 'admin': {
        const { request } = message;
        this.options.admin.run(request).then(
          (result) => {
            this.sendTo(ws, { type: 'adminResult', action: request.action, ok: result.ok, message: result.message });
            for (const id of result.reset ?? []) this.send({ type: 'sessionReset', id });
          },
          (error: unknown) => this.sendTo(ws, { type: 'adminResult', action: request.action, ok: false, message: error instanceof Error ? error.message : String(error) }),
        );
        break;
      }
      case 'systemLog':
        this.sendTo(ws, { type: 'systemLog', text: this.options.admin.log() });
        break;
      case 'exportData':
        this.sendTo(ws, { type: 'exportData', json: this.options.admin.exportData() });
        break;
      case 'git':
      case 'gitCommit':
      case 'gitDiff':
        this.handleGit(message, ws);
        break;
      case 'listRepos':
        this.sendTo(ws, { type: 'repos', repos: this.options.repos() });
        break;
      case 'refreshReviews':
        void this.options.reviews.refresh();
        break;
      case 'prDetails': {
        const { url } = message;
        this.options
          .prDetails(url)
          .then(parsePrDetails)
          .then(
            (details) => this.sendTo(ws, { type: 'prDetails', url, details, error: null }),
            (error: unknown) => this.sendTo(ws, { type: 'prDetails', url, details: null, error: error instanceof Error ? error.message : String(error) }),
          );
        break;
      }
    }
  }

  /**
   * Where to run git for a workspace: the directory its claude reports, when that is another worktree
   * of the same repository (claude moves into worktrees on its own), else the workspace's own.
   */
  private async gitDirectory(workspace: Workspace): Promise<string> {
    const reported = this.options.workingDir(workspace.id);
    if (!reported || reported === workspace.cwd || !isAbsolute(reported) || !isDirectory(reported)) return workspace.cwd;
    return (await this.options.git.sameRepository(workspace.cwd, reported)) ? reported : workspace.cwd;
  }

  /** Answers a git request for a workspace's directory; the reply goes to the asking client only. */
  private handleGit(message: Extract<ControlToHelper, { type: 'git' | 'gitCommit' | 'gitDiff' }>, ws: WebSocket): void {
    const { store, git } = this.options;
    const { id } = message;
    const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
    const workspace = store.get(id);
    const missing = 'unknown workspace';
    const dir = workspace ? this.gitDirectory(workspace) : null;
    if (message.type === 'git') {
      if (!dir) return this.sendTo(ws, { type: 'git', id, state: null, error: missing });
      dir.then((cwd) => git.state(cwd)).then(
        (state) => this.sendTo(ws, { type: 'git', id, state, error: null }),
        (error: unknown) => this.sendTo(ws, { type: 'git', id, state: null, error: text(error) }),
      );
    } else if (message.type === 'gitCommit') {
      const { sha } = message;
      if (!dir) return this.sendTo(ws, { type: 'gitCommit', id, sha, files: [], error: missing });
      dir.then((cwd) => git.commitFiles(cwd, sha)).then(
        (files) => this.sendTo(ws, { type: 'gitCommit', id, sha, files, error: null }),
        (error: unknown) => this.sendTo(ws, { type: 'gitCommit', id, sha, files: [], error: text(error) }),
      );
    } else {
      const { path } = message;
      const sha = message.sha ?? null;
      if (!dir) return this.sendTo(ws, { type: 'gitDiff', id, path, sha, diff: '', truncated: false, error: missing });
      dir.then((cwd) => git.diff(cwd, path, sha)).then(
        ({ diff, truncated }) => this.sendTo(ws, { type: 'gitDiff', id, path, sha, diff, truncated, error: null }),
        (error: unknown) => this.sendTo(ws, { type: 'gitDiff', id, path, sha, diff: '', truncated: false, error: text(error) }),
      );
    }
  }

  private sendTo(ws: WebSocket, message: ControlToClient): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }
}

function isWindowId(value: unknown): value is number {
  return Number.isInteger(value);
}

function isWebUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && /^https?:\/\/\S+$/i.test(value);
}

function isWorkspaceName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80;
}

const PLAIN_ACTIONS = new Set(['restartHelper', 'stopHelper', 'clearUploads', 'clearLog', 'pruneWorktrees', 'checkGh']);

function isAdminAction(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.action !== 'string') return false;
  if (PLAIN_ACTIONS.has(r.action)) return true;
  if (r.action === 'restartSession') return typeof r.id === 'string';
  if (r.action === 'killProcess') return typeof r.id === 'string' && Number.isInteger(r.pid) && (r.pid as number) > 1 && (r.force === undefined || typeof r.force === 'boolean');
  return false;
}

function isControlToHelper(value: unknown): value is ControlToHelper {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case 'pair':
      return typeof m.id === 'string' && isWindowId(m.windowId) && (m.groupId === undefined || isWindowId(m.groupId));
    case 'unpair':
      return isWindowId(m.windowId);
    case 'unpairGroup':
      return isWindowId(m.groupId);
    case 'tabs':
      return (
        isWindowId(m.windowId) &&
        (m.groupId === undefined || isWindowId(m.groupId)) &&
        Array.isArray(m.urls) &&
        m.urls.every((u) => typeof u === 'string')
      );
    case 'remove':
      return typeof m.id === 'string';
    case 'rename':
      return typeof m.id === 'string' && isWorkspaceName(m.name);
    case 'order':
      return Array.isArray(m.ids) && m.ids.length <= 500 && m.ids.every((id) => typeof id === 'string');
    case 'move':
      return typeof m.id === 'string' && Number.isInteger(m.index) && (m.index as number) >= 0;
    case 'create':
      return (
        isWorkspaceName(m.name) &&
        (m.windowId === null || isWindowId(m.windowId)) &&
        (m.pr === undefined || (typeof m.pr === 'string' && isPullRequestUrl(m.pr))) &&
        (m.prompt === undefined || (typeof m.prompt === 'string' && m.prompt.length <= MAX_PROMPT_LENGTH)) &&
        (m.cwd === undefined || (typeof m.cwd === 'string' && m.cwd.length <= 1024)) &&
        (m.model === undefined || (typeof m.model === 'string' && MODEL_PATTERN.test(m.model))) &&
        (m.group === undefined || typeof m.group === 'boolean') &&
        (m.urls === undefined || (Array.isArray(m.urls) && m.urls.length <= MAX_TAB_URLS && m.urls.every(isWebUrl)))
      );
    case 'system':
    case 'systemLog':
    case 'exportData':
      return true;
    case 'admin':
      return isAdminAction(m.request);
    case 'git':
      return typeof m.id === 'string';
    case 'gitCommit':
      return typeof m.id === 'string' && typeof m.sha === 'string' && /^[0-9a-f]{7,40}$/.test(m.sha);
    case 'gitDiff':
      return (
        typeof m.id === 'string' &&
        typeof m.path === 'string' &&
        m.path.length > 0 &&
        m.path.length <= 1024 &&
        (m.sha === undefined || (typeof m.sha === 'string' && /^[0-9a-f]{7,40}$/.test(m.sha)))
      );
    case 'listPrompts':
    case 'listRepos':
    case 'refreshReviews':
      return true;
    case 'prDetails':
      return typeof m.url === 'string' && isPullRequestUrl(m.url);
    default:
      return false;
  }
}
