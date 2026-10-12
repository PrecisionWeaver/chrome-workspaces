import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HistoryEntry, Workspace } from '../../shared/protocol';

export const MAX_HISTORY = 50;

/** Workspaces that were removed, newest first, so one can be brought back with its conversation. */
export class HistoryStore {
  private entries: HistoryEntry[];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly file: string) {
    this.entries = this.load();
  }

  list(): HistoryEntry[] {
    return this.entries.map((e) => ({ ...e, tabs: [...e.tabs] }));
  }

  get(id: string): HistoryEntry | undefined {
    return this.list().find((e) => e.id === id);
  }

  /** Remembers a workspace as it was when it was removed. `resumeId` is its claude session, if it had one. */
  record(workspace: Workspace, resumeId: string | null): void {
    const entry: HistoryEntry = {
      id: `h-${randomBytes(4).toString('hex')}`,
      name: workspace.name,
      cwd: workspace.cwd,
      ticket: workspace.ticket,
      url: workspace.url,
      pr: workspace.pr,
      model: workspace.model,
      tabs: [...workspace.lastTabUrls],
      pinned: workspace.pinned,
      color: workspace.color,
      resumeId,
      closedAt: new Date().toISOString(),
    };
    this.entries = [entry, ...this.entries].slice(0, MAX_HISTORY);
    this.save();
  }

  remove(id: string): void {
    const next = this.entries.filter((e) => e.id !== id);
    if (next.length === this.entries.length) return;
    this.entries = next;
    this.save();
  }

  clear(): void {
    if (this.entries.length === 0) return;
    this.entries = [];
    this.save();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private load(): HistoryEntry[] {
    if (!existsSync(this.file)) return [];
    try {
      const { entries } = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: HistoryEntry[] };
      // Entries written before pin and color were kept load with them unset.
      return Array.isArray(entries) ? entries.slice(0, MAX_HISTORY).map((e) => ({ ...e, pinned: e.pinned ?? false, color: e.color ?? null })) : [];
    } catch {
      // History is a convenience: a damaged file starts it again rather than stopping the helper.
      return [];
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ entries: this.entries }, null, 2)}\n`);
    renameSync(tmp, this.file);
    for (const listener of this.listeners) listener();
  }
}
