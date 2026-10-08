import { isAbsolute } from 'node:path';
import type { WebSocket } from 'ws';
import { MAX_PROMPT_LENGTH, MODEL_PATTERN, type ControlToClient, type ControlToHelper, type Prompt, type Repo, type ReviewsState, type WorkspaceStatus } from '../../shared/protocol';
import { isDirectory } from './config';
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
        const cwd = message.cwd && isAbsolute(message.cwd) && isDirectory(message.cwd) ? message.cwd : defaultCwd;
        const base = message.pr ? prWorkspace(message.pr, { reviews: reviews.state().items, repoDirs, defaultCwd }) : { cwd };
        const workspace = store.create({
          ...base,
          name: message.name.trim(),
          prompt: message.prompt?.trim() || null,
          model: message.model ?? null,
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
      case 'remove':
        this.options.sessions.remove(message.id);
        store.remove(message.id);
        break;
      case 'listPrompts':
        this.sendTo(ws, this.prompts());
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

  private sendTo(ws: WebSocket, message: ControlToClient): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }
}

function isWindowId(value: unknown): value is number {
  return Number.isInteger(value);
}

function isWorkspaceName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80;
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
        (m.group === undefined || typeof m.group === 'boolean')
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
