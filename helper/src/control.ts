import type { WebSocket } from 'ws';
import type { ControlToClient, ControlToHelper, WorkspaceStatus } from '../../shared/protocol';
import type { SessionManager } from './session';
import type { WorkspaceStore } from './workspace-store';

export interface ControlHubOptions {
  store: WorkspaceStore;
  sessions: SessionManager;
  defaultCwd: string;
  statuses: () => Record<string, WorkspaceStatus>;
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
      if (isControlToHelper(message)) this.handle(message);
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
    return { type: 'state', workspaces: this.options.store.list(), statuses: this.options.statuses() };
  }

  private handle(message: ControlToHelper): void {
    const { store } = this.options;
    switch (message.type) {
      case 'pair':
        if (store.get(message.id)) store.pairWindow(message.id, message.windowId);
        break;
      case 'unpair':
        store.unpairWindow(message.windowId);
        break;
      case 'tabs':
        store.setTabs(message.windowId, message.urls);
        break;
      case 'create': {
        const workspace = store.create({ name: message.name, cwd: this.options.defaultCwd });
        if (message.windowId === null) this.send({ type: 'open', id: workspace.id });
        else store.pairWindow(workspace.id, message.windowId);
        break;
      }
      case 'remove':
        this.options.sessions.remove(message.id);
        store.remove(message.id);
        break;
    }
  }

  private sendTo(ws: WebSocket, message: ControlToClient): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  }
}

function isWindowId(value: unknown): value is number {
  return Number.isInteger(value);
}

function isControlToHelper(value: unknown): value is ControlToHelper {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  switch (m.type) {
    case 'pair':
      return typeof m.id === 'string' && isWindowId(m.windowId);
    case 'unpair':
      return isWindowId(m.windowId);
    case 'tabs':
      return isWindowId(m.windowId) && Array.isArray(m.urls) && m.urls.every((u) => typeof u === 'string');
    case 'remove':
      return typeof m.id === 'string';
    case 'create':
      return typeof m.name === 'string' && m.name.trim().length > 0 && m.name.length <= 80 && (m.windowId === null || isWindowId(m.windowId));
    default:
      return false;
  }
}
