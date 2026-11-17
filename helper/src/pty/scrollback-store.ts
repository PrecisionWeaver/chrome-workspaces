import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What ends the saved part of a restored terminal: the modes a full-screen program may have left on are turned off
 * (the alternate screen, a hidden cursor, mouse reporting, bracketed paste), since the program that would have turned
 * them off is gone, and a dim line says where the old output ends.
 */
export const RESTORED_MARK =
  '\x1b[?1049l\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l\x1b[0m\r\n\x1b[2m── the helper restarted; the output above is from before ──\x1b[0m\r\n';

/**
 * Terminal scrollback kept across a helper restart: saved when the helper stops, and read once by the session that
 * next starts under the same id. A file per session, in a folder only the user can read.
 */
export class ScrollbackStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string | null {
    // The id becomes a file name.
    return /^[\w-]{1,64}$/.test(id) ? join(this.dir, `${id}.txt`) : null;
  }

  save(id: string, text: string): void {
    const file = this.file(id);
    if (!file || !text) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(file, text, { mode: 0o600 });
  }

  /** The saved scrollback of a session, which is then forgotten: it is the new session's to keep from here. */
  take(id: string): string | null {
    const file = this.file(id);
    if (!file) return null;
    try {
      const text = readFileSync(file, 'utf8');
      rmSync(file, { force: true });
      return text || null;
    } catch {
      return null;
    }
  }

  drop(id: string): void {
    const file = this.file(id);
    if (file) rmSync(file, { force: true });
  }

  /** Deletes what was saved for sessions nobody came back to in a month. */
  prune(now = Date.now()): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(this.dir, name);
      try {
        if (now - statSync(path).mtimeMs > RETENTION_MS) rmSync(path, { force: true });
      } catch {
        // Gone already.
      }
    }
  }
}
