import { statSync } from 'node:fs';

/**
 * Remembers what was computed from a file for as long as the file is unchanged (same size, modification
 * time and inode; the hook replaces a status file by rename, which changes the inode). The helper rereads
 * session files and transcript tails on every hook event, and most of them have not changed since the last.
 */
export class StatCache<T> {
  private readonly entries = new Map<string, { stamp: string; at: number; value: T }>();

  /** `maxAgeMs` is for results that also depend on the clock; `maxEntries` keeps the oldest from piling up. */
  constructor(
    private readonly maxAgeMs = Number.POSITIVE_INFINITY,
    private readonly maxEntries = 500,
  ) {}

  /** The value for `path`, computed again when the file has changed or the entry is too old. `key` tells apart several values read from one file. */
  get(path: string, compute: () => T, key = path, now = Date.now()): T {
    let stamp: string;
    try {
      const info = statSync(path);
      stamp = `${info.size}:${info.mtimeMs}:${info.ino}`;
    } catch {
      // Unreadable: nothing worth remembering, and compute decides what that means.
      this.entries.delete(key);
      return compute();
    }
    const entry = this.entries.get(key);
    if (entry && entry.stamp === stamp && now - entry.at < this.maxAgeMs) return entry.value;
    const value = compute();
    this.entries.delete(key);
    this.entries.set(key, { stamp, at: now, value });
    if (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
    return value;
  }
}
