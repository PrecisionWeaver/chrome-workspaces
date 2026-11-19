import type { WebSocket } from 'ws';
import type { ActivityItem } from '../../../shared/sessions/activity';
import { workspaceShellSession } from '../../../shared/protocol/protocol';
import type { ControlToClient, ControlToHelper } from '../../../shared/protocol/protocol';
import type { PastSession, Prompt, Repo, WaitingOn, Workspace, WorkspaceStatus } from '../../../shared/protocol/workspace';
import type { ReviewsState } from '../../../shared/protocol/pull-requests';
import type { ConfigEdit, ConfigEditValues } from '../../../shared/protocol/system';
import type { SaveResult } from '../platform/config-edit';
import { isControlToHelper } from './messages';
import type { AdminService } from '../admin/admin';
import type { Template } from '../../../shared/workspaces/templates';
import { asPaste, MAX_PASTE_LENGTH } from '../pty/paste';
import type { GitService } from '../git/git';
import type { HistoryStore } from '../store/history';
import type { SessionManager } from '../pty/session';
import type { WorkspaceStore } from '../store/workspace-store';
import { errorMessage } from '../../../shared/protocol/errors';
import { handleAdmin, isAdminRequest } from './admin-handlers';
import { handleGit, isGitRequest } from './git-handlers';
import { handlePr, isPrRequest } from './pr-handlers';
import { handleWorkspace, isWorkspaceRequest, restoreWorkspace } from './workspace-handlers';

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
  /** The Settings config editor: the editable fields with the prompts note, and saving them (which applies them). */
  configEdit: { read(): ConfigEdit; save(values: ConfigEditValues, prompts: string | null): SaveResult };
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
  /** How many extension contexts are connected. */
  readonly clientCount: number;
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
  /** What each following client was last sent, so an unrelated session's change does not send it the same turns again. */
  private readonly sentActivity = new Map<WebSocket, string>();

  constructor(readonly options: ControlHubOptions) {
    options.store.onChange(() => this.broadcastState());
    options.history.onChange(() => this.send(this.historyMessage()));
  }

  get clientCount(): number {
    return this.clients.size;
  }

  add(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
      this.following.delete(ws);
      this.sentActivity.delete(ws);
    });
    ws.on('message', (raw) => {
      let message: unknown;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        console.error('control: dropped a message that is not JSON');
        return;
      }
      if (!isControlToHelper(message)) {
        const type = typeof message === 'object' && message !== null ? (message as { type?: unknown }).type : undefined;
        console.error(`control: dropped an invalid ${typeof type === 'string' ? type.slice(0, 40) : 'unknown'} message`);
        return;
      }
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
    for (const [ws, id] of this.following) this.sendActivity(ws, id, true);
  }

  /** Sends a client a workspace's activity; with `changedOnly`, not when it is what that client was last sent. */
  private sendActivity(ws: WebSocket, id: string, changedOnly = false): void {
    const message = this.activityMessage(id);
    const json = JSON.stringify(message);
    if (changedOnly && this.sentActivity.get(ws) === json) return;
    this.sentActivity.set(ws, json);
    this.sendTo(ws, message);
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

  /** Brings an archived workspace back in a window of its own, as the panel's Archived list does; undefined when the archive has no such entry. */
  restore(historyId: string): Workspace | undefined {
    return restoreWorkspace(this, historyId, null);
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
    if (isAdminRequest(message)) {
      handleAdmin(this, message, ws);
      return;
    }
    if (isPrRequest(message)) {
      handlePr(this, message, ws);
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
          const cut = message.text.length > MAX_PASTE_LENGTH ? `the first ${MAX_PASTE_LENGTH.toLocaleString('en-US')} characters` : 'it';
          this.sendTo(ws, { type: 'sent', id, ok: true, message: `Pasted ${cut} into its terminal, not submitted.` });
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
      case 'activity':
        if (message.id === null) {
          this.following.delete(ws);
          this.sentActivity.delete(ws);
          break;
        }
        this.following.set(ws, message.id);
        this.sendActivity(ws, message.id);
        break;
      case 'listRepos':
        this.sendTo(ws, { type: 'repos', repos: this.options.repos() });
        break;
      case 'refreshReviews':
        void this.options.reviews.refresh();
        break;
    }
  }
}
