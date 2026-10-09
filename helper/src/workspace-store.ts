import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Workspace } from '../../shared/protocol';

export interface NewWorkspace {
  name: string;
  ticket?: string | null;
  cwd: string;
  url?: string | null;
  pr?: string | null;
  prompt?: string | null;
  model?: string | null;
  /** Tabs to open with the workspace; they become its remembered tabs. */
  tabs?: string[];
}

export class WorkspaceStore {
  private workspaces: Workspace[];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly file: string) {
    this.workspaces = this.load();
  }

  list(): Workspace[] {
    return this.workspaces.map((ws) => ({ ...ws }));
  }

  get(id: string): Workspace | undefined {
    return this.list().find((ws) => ws.id === id);
  }

  findByTicket(ticket: string): Workspace | undefined {
    return this.list().find((ws) => ws.ticket?.toUpperCase() === ticket.toUpperCase());
  }

  findByPr(url: string): Workspace | undefined {
    return this.list().find((ws) => ws.pr === url);
  }

  findByWindow(windowId: number): Workspace | undefined {
    return this.list().find((ws) => ws.windowId === windowId);
  }

  create(input: NewWorkspace): Workspace {
    const workspace: Workspace = {
      id: `ws-${randomBytes(4).toString('hex')}`,
      name: input.name,
      ticket: input.ticket ?? null,
      cwd: input.cwd,
      url: input.url ?? null,
      windowId: null,
      groupId: null,
      model: input.model ?? null,
      lastTabUrls: [...(input.tabs ?? [])],
      pr: input.pr ?? null,
      prompt: input.prompt ?? null,
      createdAt: new Date().toISOString(),
    };
    this.workspaces.push(workspace);
    this.save();
    return { ...workspace };
  }

  /** A workspace has one window, which it may share; a tab group belongs to one workspace, so pairing takes it from anyone else. */
  pairWindow(id: string, windowId: number, groupId: number | null = null): void {
    const target = this.require(id);
    if (groupId !== null) for (const ws of this.workspaces) if (ws.groupId === groupId) ws.groupId = null;
    target.windowId = windowId;
    target.groupId = groupId;
    this.save();
  }

  /** Frees every workspace in the window. Keeps `lastTabUrls`, which is what re-pairs a workspace when its tabs come back. */
  unpairWindow(windowId: number): void {
    const paired = this.workspaces.filter((w) => w.windowId === windowId);
    for (const ws of paired) {
      ws.windowId = null;
      ws.groupId = null;
    }
    if (paired.length) this.save();
  }

  unpairGroup(groupId: number): void {
    const ws = this.workspaces.find((w) => w.groupId === groupId);
    if (!ws) return;
    ws.groupId = null;
    this.save();
  }

  setTabs(windowId: number, urls: string[], groupId: number | null = null): void {
    const ws = this.workspaces.find((w) => w.windowId === windowId && w.groupId === groupId);
    if (!ws) return;
    ws.lastTabUrls = [...urls];
    this.save();
  }

  rename(id: string, name: string): void {
    this.require(id).name = name;
    this.save();
  }

  /** Moves a workspace to `index` in the list, which is the order the panel shows and switching follows. */
  move(id: string, index: number): void {
    const ws = this.require(id);
    const rest = this.workspaces.filter((w) => w !== ws);
    rest.splice(Math.max(0, Math.min(index, rest.length)), 0, ws);
    this.workspaces = rest;
    this.save();
  }

  /** Sets the list order. Ignored unless `ids` holds every workspace exactly once. Returns whether it applied. */
  reorder(ids: readonly string[]): boolean {
    const byId = new Map(this.workspaces.map((w) => [w.id, w]));
    if (ids.length !== byId.size || new Set(ids).size !== ids.length || !ids.every((id) => byId.has(id))) return false;
    const next = ids.map((id) => byId.get(id)!);
    if (next.every((w, i) => w === this.workspaces[i])) return true;
    this.workspaces = next;
    this.save();
    return true;
  }

  clearPrompt(id: string): void {
    const ws = this.require(id);
    if (ws.prompt === null) return;
    ws.prompt = null;
    this.save();
  }

  remove(id: string): void {
    this.workspaces = this.workspaces.filter((ws) => ws.id !== id);
    this.save();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private require(id: string): Workspace {
    const ws = this.workspaces.find((w) => w.id === id);
    if (!ws) throw new Error(`unknown workspace ${id}`);
    return ws;
  }

  private load(): Workspace[] {
    if (!existsSync(this.file)) return [];
    try {
      const { workspaces } = JSON.parse(readFileSync(this.file, 'utf8')) as { workspaces: Workspace[] };
      // Files written before a field existed load with it unset.
      return workspaces.map((ws) => ({ ...ws, pr: ws.pr ?? null, prompt: ws.prompt ?? null, groupId: ws.groupId ?? null, model: ws.model ?? null }));
    } catch (error) {
      throw new Error(`cannot read ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ workspaces: this.workspaces }, null, 2)}\n`);
    renameSync(tmp, this.file);
    for (const listener of this.listeners) listener();
  }
}
