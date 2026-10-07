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
      lastTabUrls: [],
      pr: input.pr ?? null,
      prompt: input.prompt ?? null,
      createdAt: new Date().toISOString(),
    };
    this.workspaces.push(workspace);
    this.save();
    return { ...workspace };
  }

  /** One window per workspace and one workspace per window: pairing takes the window from anyone else. */
  pairWindow(id: string, windowId: number): void {
    const target = this.require(id);
    for (const ws of this.workspaces) if (ws.windowId === windowId) ws.windowId = null;
    target.windowId = windowId;
    this.save();
  }

  /** Keeps `lastTabUrls`, which is what re-pairs the workspace when its window comes back. */
  unpairWindow(windowId: number): void {
    const ws = this.workspaces.find((w) => w.windowId === windowId);
    if (!ws) return;
    ws.windowId = null;
    this.save();
  }

  setTabs(windowId: number, urls: string[]): void {
    const ws = this.workspaces.find((w) => w.windowId === windowId);
    if (!ws) return;
    ws.lastTabUrls = [...urls];
    this.save();
  }

  rename(id: string, name: string): void {
    this.require(id).name = name;
    this.save();
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
      return workspaces.map((ws) => ({ ...ws, pr: ws.pr ?? null, prompt: ws.prompt ?? null }));
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
