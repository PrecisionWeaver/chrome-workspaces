import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UsageBucket } from './tokens';

/** What one transcript used, as it was when last counted. */
export interface LedgerEntry {
  transcript: string;
  workspaceId: string;
  /** The workspace's name when the transcript was last counted, for showing it once the workspace is archived. */
  name: string;
  /** When the transcript's file was created; only an older one can be what it copied. */
  createdMs: number;
  /** The transcript's modification time when it was counted, so a later write is counted again. */
  mtimeMs: number;
  /** When its newest counted message was written, so a transcript copied from this one can leave the copies out. */
  lastAt: number | null;
  buckets: UsageBucket[];
}

/**
 * Each counted transcript's usage by model, day and hour, kept apart from the transcripts themselves. Archived
 * workspaces, sessions left behind by `/clear` and transcripts claude has since deleted still count from here, and
 * the helper does not need to hold or read them again. Only the days the trend shows are kept.
 */
export class UsageLedger {
  private entries: Map<string, LedgerEntry>;
  private dirty = false;

  constructor(private readonly file: string) {
    this.entries = this.load();
  }

  list(): LedgerEntry[] {
    return [...this.entries.values()];
  }

  get(transcript: string): LedgerEntry | undefined {
    return this.entries.get(transcript);
  }

  /** Replaces what a transcript used: a transcript is counted whole each time, so a resumed one is never added twice. */
  record(entry: LedgerEntry): void {
    const seen = this.entries.get(entry.transcript);
    if (seen && seen.mtimeMs === entry.mtimeMs && seen.name === entry.name && seen.workspaceId === entry.workspaceId) return;
    // A message with no date has no day in the trend, which is all the ledger is read for.
    this.entries.set(entry.transcript, { ...entry, buckets: entry.buckets.filter((b) => b.day) });
    this.dirty = true;
  }

  /** Drops days before `oldest`, and folds the hours of days before `today` into their day, since only today is drawn by hour. */
  prune(oldest: string, today: string): void {
    for (const [transcript, entry] of this.entries) {
      const folded = new Map<string, UsageBucket>();
      let changed = false;
      for (const bucket of entry.buckets) {
        if (bucket.day < oldest) {
          changed = true;
          continue;
        }
        const hour = bucket.day < today ? null : bucket.hour;
        if (hour !== bucket.hour) changed = true;
        const key = `${bucket.model}|${bucket.day}|${hour}`;
        const into = folded.get(key);
        if (!into) {
          folded.set(key, { ...bucket, hour, usage: { ...bucket.usage } });
          continue;
        }
        into.usage.input += bucket.usage.input;
        into.usage.output += bucket.usage.output;
        into.usage.cacheWrite += bucket.usage.cacheWrite;
        into.usage.cacheRead += bucket.usage.cacheRead;
      }
      if (!changed) continue;
      this.dirty = true;
      if (folded.size === 0) this.entries.delete(transcript);
      else entry.buckets = [...folded.values()];
    }
  }

  /**
   * When the workspace's transcripts created before `createdMs` last wrote, for leaving out what a transcript created then
   * copied from them; null if it has none. A newer one is never counted against it, so a resumed transcript keeps its own.
   */
  earlierEnded(workspaceId: string, createdMs: number): number | null {
    let latest: number | null = null;
    for (const entry of this.entries.values()) {
      if (entry.workspaceId !== workspaceId || entry.createdMs >= createdMs || entry.lastAt === null) continue;
      if (latest === null || entry.lastAt > latest) latest = entry.lastAt;
    }
    return latest;
  }

  /** Writes the file if anything changed since it was last written. */
  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ entries: this.list() })}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  private load(): Map<string, LedgerEntry> {
    if (!existsSync(this.file)) return new Map();
    try {
      const { entries } = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: LedgerEntry[] };
      return new Map((Array.isArray(entries) ? entries : []).map((e) => [e.transcript, e]));
    } catch {
      // A damaged file starts the ledger again rather than stopping the helper; live transcripts are counted back in.
      return new Map();
    }
  }
}
