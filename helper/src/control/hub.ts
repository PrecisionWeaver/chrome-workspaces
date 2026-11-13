import type { WebSocket } from 'ws';
import type { ActivityItem } from '../../../shared/sessions/activity';
import { workspaceShellSession } from '../../../shared/protocol/protocol';
import type { ControlToClient, ControlToHelper, PastSession, Prompt, Repo, ReviewsState, WaitingOn, WorkspaceStatus } from '../../../shared/protocol/protocol';
import { isControlToHelper } from './messages';
import type { AdminService } from '../admin/admin';
import type { Template } from '../../../shared/workspaces/templates';
import { asPaste } from '../pty/paste';
import type { GitService } from '../git/git';
import type { HistoryStore } from '../store/history';
import { parsePrDetails, parsePrThreads, parsePrUrl } from '../git/pr-details';
import type { SessionManager } from '../pty/session';
import type { WorkspaceStore } from '../store/workspace-store';
import { errorMessage } from '../../../shared/protocol/errors';
import { handleGit, isGitRequest } from './git-handlers';
import { handleWorkspace, isWorkspaceRequest } from './workspace-handlers';

export interface ReviewSource {
  state(): ReviewsState;
  refresh(): Promise<void>;
}

export interface ControlHubOptions {
  store: WorkspaceStore;
  sessions: SessionManager;
  defaultCwd: string;
  statuses: () => Record<string, WorkspaceStatus>;
  /** What each waiting workspace waits on; only workspaces at `needs_input` have an entry. */
  waiting: () => Record<string, WaitingOn>;
  reviews: ReviewSource;
  /** Throws when the prompts file cannot be read. */
  prompts: () => Prompt[];
  /** The team's templates; throws when their file cannot be read. */
  templates: () => Template[];
  /** Raw `gh pr view` JSON for a PR url. */
  prDetails: (url: string) => Promise<string>;
  /** Raw GraphQL JSON of a pull request's review threads. */
  prThreads: (parts: { owner: string; repo: string; number: string }) => Promise<string>;
  /** Raw `gh pr view` JSON for the branch checked out in a directory; rejects when it has no pull request. */
  branchPr: (cwd: string) => Promise<string>;
  /** Opens a draft pull request for the branch checked out in a directory and resolves to its url. */
  createPr: (cwd: string) => Promise<string>;
  repoDirs: Record<string, string>;
  repos: () => Repo[];
  git: GitService;
  admin: AdminService;
  history: HistoryStore;
  /** The claude session a workspace is on, to resume if it is restored. */
  resumeId: (id: string) => string | null;
  /** Every claude session a workspace has had, newest first. */
  pastSessions: (id: string) => PastSession[];
  /** Ends the workspace's terminal so that its next start resumes `sessionId`. */
  resumeWith: (id: string, sessionId: string) => void;
  /** The directory a workspace's claude last reported working in, if it has reported one. */
  workingDir: (id: string) => string | null;
  /** The recent turns of a workspace's claude session; null when it has no session. */
  activity: (id: string) => ActivityItem[] | null;
}

/** What a message handler outside the hub gets to work with: the hub's options and its ways of replying. */
export interface HubContext {
  readonly options: ControlHubOptions;
  /** Sends every connected client a message; returns whether any received it. */
  send(message: ControlToClient): boolean;
  /** Sends one client a message. */
  sendTo(ws: WebSocket, message: ControlToClient): void;
  /** Sends the asking client what `work` resolves to, in the `ok` shape, or its failure in the `fail` shape. */
  answer<T>(ws: WebSocket, work: Promise<T>, ok: (value: T) => ControlToClient, fail: (reason: string) => ControlToClient): void;
}

/** Keeps every connected extension context (service worker, panels) in sync with the store. */
export class ControlHub implements HubContext {
  private readonly clients = new Set<WebSocket>();
  // The workspace each client is watching the activity of, if any.
  private readonly following = new Map<WebSocket, string>();

  constructor(readonly options: ControlHubOptions) {
    options.store.onChange(() => this.broadcastState());
    options.history.onChange(() => this.send(this.historyMessage()));
  }

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
      this.following.delete(ws);
    });
    ws.on('message', (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!isControlToHelper(message)) return;
      try {
        this.handle(message, ws);
      } catch (error) {
        // A failed save must not take the helper, and every terminal, down with it.
        console.error(`control: ${message.type} failed: ${errorMessage(error)}`);
      }
    });
    this.sendTo(ws, this.state());
    this.sendTo(ws, this.historyMessage());
  }

  /** Returns whether any extension context received it. */
  send(message: ControlToClient): boolean {
    for (const ws of this.clients) this.sendTo(ws, message);
    return this.clients.size > 0;
  }

  sendTo(ws: WebSocket, message: ControlToClient): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }

  answer<T>(ws: WebSocket, work: Promise<T>, ok: (value: T) => ControlToClient, fail: (reason: string) => ControlToClient): void {
    work.then(
      (value) => this.sendTo(ws, ok(value)),
      (error: unknown) => this.sendTo(ws, fail(errorMessage(error))),
    );
  }

  broadcastState(): void {
    this.send(this.state());
  }

  /** Sends each following client its workspace's activity again; called when a session's events change. */
  pushActivity(): void {
    for (const [ws, id] of this.following) this.sendTo(ws, this.activityMessage(id));
  }

  /** Archives a workspace: remembers it under Archived, ends its terminals, and closes its tabs when asked to. */
  remove(id: string, closeTabs = false): void {
    const { store } = this.options;
    const removing = store.get(id);
    // Remembered before it goes, with the conversation it was on, so it can be restored.
    if (removing) this.options.history.record(removing, this.options.resumeId(id));
    this.options.sessions.remove(id);
    this.options.sessions.remove(workspaceShellSession(id));
    store.remove(id);
    if (removing?.windowId != null && closeTabs) {
      // A window shared with other workspaces is theirs too: only a group can be closed out of it.
      const shared = store.list().some((ws) => ws.windowId === removing.windowId);
      if (removing.groupId !== null || !shared) this.send({ type: 'closeTabs', windowId: removing.windowId, groupId: removing.groupId });
    }
  }

  private activityMessage(id: string): ControlToClient {
    const items = this.options.store.get(id) ? this.options.activity(id) : null;
    return { type: 'activity', id, items: items ?? [], error: items === null ? 'This workspace has no claude session yet.' : null };
  }

  private historyMessage(): ControlToClient {
    return { type: 'history', entries: this.options.history.list() };
  }

  private state(): ControlToClient {
    const { store, statuses, waiting, reviews } = this.options;
    return { type: 'state', workspaces: store.list(), statuses: statuses(), waiting: waiting(), reviews: reviews.state() };
  }

  /** A reply that carries what `read` returns, or an empty one naming why it could not be read. */
  private listing<T>(read: () => T, empty: T, reply: (value: T, error: string | null) => ControlToClient): ControlToClient {
    try {
      return reply(read(), null);
    } catch (error) {
      return reply(empty, errorMessage(error));
    }
  }

  private handle(message: ControlToHelper, ws: WebSocket): void {
    if (isWorkspaceRequest(message)) {
      handleWorkspace(this, message, ws);
      return;
    }
    if (isGitRequest(message)) {
      handleGit(this, message, ws);
      return;
    }
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
      case 'listSessions':
        if (store.get(message.id)) this.sendTo(ws, { type: 'sessions', id: message.id, sessions: this.options.pastSessions(message.id) });
        break;
      case 'resumeSession':
        if (store.get(message.id)) {
          this.options.resumeWith(message.id, message.sessionId);
          this.send({ type: 'sessionReset', id: message.id });
        }
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
      case 'remove':
        this.remove(message.id, message.closeTabs === true);
        break;
      case 'listPrompts':
        this.sendTo(
          ws,
          this.listing(this.options.prompts, [], (prompts, error) => ({ type: 'prompts', prompts, error })),
        );
        break;
      case 'listTemplates':
        this.sendTo(
          ws,
          this.listing(this.options.templates, [], (templates, error) => ({ type: 'templates', templates, error })),
        );
        break;
      case 'system':
        this.answer(
          ws,
          this.options.admin.snapshot({ reviews: this.options.reviews.state(), clients: this.clients.size }),
          (snapshot) => ({ type: 'system', snapshot, error: null }),
          (error) => ({ type: 'system', snapshot: null, error }),
        );
        break;
      case 'admin': {
        const { request } = message;
        this.answer(
          ws,
          this.options.admin.run(request),
          (result) => {
            for (const id of result.reset ?? []) this.send({ type: 'sessionReset', id });
            return { type: 'adminResult', action: request.action, ok: result.ok, message: result.message };
          },
          (message) => ({ type: 'adminResult', action: request.action, ok: false, message }),
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
      case 'activity':
        if (message.id === null) {
          this.following.delete(ws);
          break;
        }
        this.following.set(ws, message.id);
        this.sendTo(ws, this.activityMessage(message.id));
        break;
      case 'exportData':
        this.sendTo(ws, { type: 'exportData', json: this.options.admin.exportData() });
        break;
      case 'checkUpdates':
        this.answer(
          ws,
          this.options.admin.checkUpdates(),
          (status) => ({ type: 'updates', status, error: null }),
          (error) => ({ type: 'updates', status: null, error }),
        );
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
        this.answer(
          ws,
          parts ? this.options.prThreads(parts).then(parsePrThreads) : Promise.reject(new Error('not a pull request URL')),
          ({ threads, total }) => ({ type: 'prThreads', url, threads, total, error: null }),
          (error) => ({ type: 'prThreads', url, threads: [], total: 0, error }),
        );
        break;
      }
      case 'prDetails': {
        const { url } = message;
        this.answer(
          ws,
          this.options.prDetails(url).then(parsePrDetails),
          (details) => ({ type: 'prDetails', url, details, error: null }),
          (error) => ({ type: 'prDetails', url, details: null, error }),
        );
        break;
      }
    }
  }
}
