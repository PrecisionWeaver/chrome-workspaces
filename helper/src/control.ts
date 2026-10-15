import { isAbsolute } from 'node:path';
import type { WebSocket } from 'ws';
import type { ControlToClient, ControlToHelper, Prompt, Repo, ReviewsState, Workspace, WorkspaceStatus } from '../../shared/protocol';
import { isDirectory } from './config';
import { isControlToHelper } from './control-messages';
import type { AdminService } from './admin';
import { asPaste } from './paste';
import type { GitService } from './git';
import type { HistoryStore } from './history';
import { parseBranchChecks, parsePrDetails, parsePrThreads, parsePrUrl } from './pr-details';
import { prWorkspace } from './pr-workspace';
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
  /** Raw GraphQL JSON of a pull request's review threads. */
  prThreads: (parts: { owner: string; repo: string; number: string }) => Promise<string>;
  /** Raw `gh pr view` JSON for the branch checked out in a directory; rejects when it has no pull request. */
  branchPr: (cwd: string) => Promise<string>;
  repoDirs: Record<string, string>;
  repos: () => Repo[];
  git: GitService;
  admin: AdminService;
  history: HistoryStore;
  /** The claude session a workspace is on, to resume if it is restored. */
  resumeId: (id: string) => string | null;
  /** The directory a workspace's claude last reported working in, if it has reported one. */
  workingDir: (id: string) => string | null;
}

/** Keeps every connected extension context (service worker, panels) in sync with the store. */
export class ControlHub {
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly options: ControlHubOptions) {
    options.store.onChange(() => this.broadcastState());
    options.history.onChange(() => this.send(this.historyMessage()));
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
    this.sendTo(ws, this.historyMessage());
  }

  /** Returns whether any extension context received it. */
  send(message: ControlToClient): boolean {
    for (const ws of this.clients) this.sendTo(ws, message);
    return this.clients.size > 0;
  }

  broadcastState(): void {
    this.send(this.state());
  }

  private historyMessage(): ControlToClient {
    return { type: 'history', entries: this.options.history.list() };
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
          color: message.color ?? null,
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
      case 'mark':
        if (store.get(message.id)) store.mark(message.id, message);
        break;
      case 'order':
        store.reorder(message.ids);
        break;
      case 'sendText': {
        const { id } = message;
        const session = store.get(id) ? this.options.sessions.get(id) : undefined;
        if (!session || session.exited) {
          this.sendTo(ws, { type: 'sent', id, ok: false, message: 'That workspace has no running terminal. Open it first, then send again.' });
        } else {
          session.write(asPaste(message.text));
          this.sendTo(ws, { type: 'sent', id, ok: true, message: 'Sent.' });
        }
        break;
      }
      case 'remove': {
        const removing = store.get(message.id);
        // Remembered before it goes, with the conversation it was on, so it can be restored.
        if (removing) this.options.history.record(removing, this.options.resumeId(message.id));
        this.options.sessions.remove(message.id);
        store.remove(message.id);
        if (removing?.windowId != null && message.closeTabs) {
          // A window shared with other workspaces is theirs too: only a group can be closed out of it.
          const shared = store.list().some((ws) => ws.windowId === removing.windowId);
          if (removing.groupId !== null || !shared) this.send({ type: 'closeTabs', windowId: removing.windowId, groupId: removing.groupId });
        }
        break;
      }
      case 'restore': {
        const entry = this.options.history.get(message.historyId);
        if (!entry) break;
        // The directory may be gone, e.g. a deleted worktree; the default directory is better than none.
        const cwd = isDirectory(entry.cwd) ? entry.cwd : this.options.defaultCwd;
        const workspace = store.create({
          name: entry.name,
          ticket: entry.ticket,
          cwd,
          url: entry.url,
          pr: entry.pr,
          model: entry.model,
          tabs: entry.tabs,
          resume: entry.resumeId,
        });
        this.options.history.remove(entry.id);
        if (entry.pinned || entry.color) store.mark(workspace.id, { pinned: entry.pinned, color: entry.color });
        if (message.windowId === null) this.send({ type: 'open', id: workspace.id });
        else {
          store.pairWindow(workspace.id, message.windowId);
          // The window already holds a workspace, so this one gets its own tab group there, with its tabs.
          this.send({ type: 'group', id: workspace.id });
        }
        break;
      }
      case 'forget':
        this.options.history.remove(message.historyId);
        break;
      case 'forgetAll':
        this.options.history.clear();
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
          (error: unknown) =>
            this.sendTo(ws, { type: 'adminResult', action: request.action, ok: false, message: error instanceof Error ? error.message : String(error) }),
        );
        break;
      }
      case 'systemLog':
        this.sendTo(ws, { type: 'systemLog', text: this.options.admin.log() });
        break;
      case 'timeline': {
        const events = this.options.store.get(message.id) ? this.options.admin.timeline(message.id) : null;
        this.sendTo(ws, {
          type: 'timeline',
          id: message.id,
          events: events ?? [],
          error: events === null ? 'This workspace has no claude session yet.' : null,
        });
        break;
      }
      case 'exportData':
        this.sendTo(ws, { type: 'exportData', json: this.options.admin.exportData() });
        break;
      case 'checkUpdates':
        this.options.admin.checkUpdates().then(
          (status) => this.sendTo(ws, { type: 'updates', status, error: null }),
          (error: unknown) => this.sendTo(ws, { type: 'updates', status: null, error: error instanceof Error ? error.message : String(error) }),
        );
        break;
      case 'git':
      case 'gitCommit':
      case 'gitDiff':
      case 'gitBranches':
      case 'gitChecks':
      case 'gitCompare':
      case 'gitStage':
      case 'gitDiscard':
      case 'gitSave':
      case 'gitSwitch':
        this.handleGit(message, ws);
        break;
      case 'listRepos':
        this.sendTo(ws, { type: 'repos', repos: this.options.repos() });
        break;
      case 'refreshReviews':
        void this.options.reviews.refresh();
        break;
      case 'prThreads': {
        const { url } = message;
        const parts = parsePrUrl(url);
        const fail = (error: string) => this.sendTo(ws, { type: 'prThreads', url, threads: [], total: 0, error });
        if (!parts) {
          fail('not a pull request URL');
          break;
        }
        this.options
          .prThreads(parts)
          .then(parsePrThreads)
          .then(
            ({ threads, total }) => this.sendTo(ws, { type: 'prThreads', url, threads, total, error: null }),
            (error: unknown) => fail(error instanceof Error ? error.message : String(error)),
          );
        break;
      }
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
  private handleGit(message: GitRequest, ws: WebSocket): void {
    const { store, git } = this.options;
    const { id } = message;
    const text = (error: unknown) => (error instanceof Error ? error.message : String(error));
    const workspace = store.get(id);
    const missing = 'unknown workspace';
    const dir = workspace ? this.gitDirectory(workspace) : null;
    const result = (action: string, work: (cwd: string) => Promise<string>) => {
      if (!dir) {
        this.sendTo(ws, { type: 'gitResult', id, action, ok: false, message: missing });
        return;
      }
      dir.then(work).then(
        (done) => this.sendTo(ws, { type: 'gitResult', id, action, ok: true, message: done }),
        (error: unknown) => this.sendTo(ws, { type: 'gitResult', id, action, ok: false, message: text(error) }),
      );
    };

    switch (message.type) {
      case 'git':
        if (!dir) {
          this.sendTo(ws, { type: 'git', id, state: null, error: missing });
          return;
        }
        dir
          .then((cwd) => git.state(cwd))
          .then(
            (state) => this.sendTo(ws, { type: 'git', id, state, error: null }),
            (error: unknown) => this.sendTo(ws, { type: 'git', id, state: null, error: text(error) }),
          );
        break;
      case 'gitCommit': {
        const { sha } = message;
        if (!dir) {
          this.sendTo(ws, { type: 'gitCommit', id, sha, files: [], error: missing });
          return;
        }
        dir
          .then((cwd) => git.commitFiles(cwd, sha))
          .then(
            (files) => this.sendTo(ws, { type: 'gitCommit', id, sha, files, error: null }),
            (error: unknown) => this.sendTo(ws, { type: 'gitCommit', id, sha, files: [], error: text(error) }),
          );
        break;
      }
      case 'gitDiff': {
        const { path } = message;
        const sha = message.sha ?? null;
        if (!dir) {
          this.sendTo(ws, { type: 'gitDiff', id, path, sha, diff: '', truncated: false, error: missing });
          return;
        }
        dir
          .then((cwd) => git.diff(cwd, path, sha, message.base === true))
          .then(
            ({ diff, truncated }) => this.sendTo(ws, { type: 'gitDiff', id, path, sha, diff, truncated, error: null }),
            (error: unknown) => this.sendTo(ws, { type: 'gitDiff', id, path, sha, diff: '', truncated: false, error: text(error) }),
          );
        break;
      }
      case 'gitChecks':
        if (!dir) {
          this.sendTo(ws, { type: 'gitChecks', id, pr: null, checks: null, error: missing });
          return;
        }
        dir
          .then((cwd) => this.options.branchPr(cwd))
          .then(
            (json) => {
              const found = parseBranchChecks(json);
              this.sendTo(ws, { type: 'gitChecks', id, pr: found?.pr ?? null, checks: found?.checks ?? null, error: null });
            },
            // `gh` exits non-zero both for "no pull request" and for a real failure; only the first is not an error.
            (error: unknown) => {
              const reason = text(error);
              const none = /no pull requests? found/i.test(reason);
              this.sendTo(ws, { type: 'gitChecks', id, pr: null, checks: null, error: none ? null : reason.split('\n')[0] });
            },
          );
        break;
      case 'gitBranches':
        if (!dir) {
          this.sendTo(ws, { type: 'gitBranches', id, branches: [], error: missing });
          return;
        }
        dir
          .then((cwd) => git.branches(cwd))
          .then(
            (branches) => this.sendTo(ws, { type: 'gitBranches', id, branches, error: null }),
            (error: unknown) => this.sendTo(ws, { type: 'gitBranches', id, branches: [], error: text(error) }),
          );
        break;
      case 'gitCompare':
        if (!dir) {
          this.sendTo(ws, { type: 'gitCompare', id, compare: null, error: missing });
          return;
        }
        dir
          .then((cwd) => git.compare(cwd))
          .then(
            (compare) => this.sendTo(ws, { type: 'gitCompare', id, compare, error: null }),
            (error: unknown) => this.sendTo(ws, { type: 'gitCompare', id, compare: null, error: text(error) }),
          );
        break;
      case 'gitStage':
        result(message.stage ? 'stage' : 'unstage', (cwd) => git.stage(cwd, message.paths, message.stage));
        break;
      case 'gitDiscard':
        result('discard', (cwd) => git.discard(cwd, message.paths));
        break;
      case 'gitSave':
        result('commit', (cwd) => git.save(cwd, message.message));
        break;
      case 'gitSwitch':
        result('switch', (cwd) => git.switchBranch(cwd, message.branch));
        break;
    }
  }

  private sendTo(ws: WebSocket, message: ControlToClient): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }
}

type GitRequest = Extract<
  ControlToHelper,
  { type: 'git' | 'gitCommit' | 'gitDiff' | 'gitBranches' | 'gitChecks' | 'gitCompare' | 'gitStage' | 'gitDiscard' | 'gitSave' | 'gitSwitch' }
>;
