import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { MAX_UPLOAD_BYTES } from '../../shared/protocol';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** A name that is safe in a path and in a shell line: the base name only, plain characters, bounded length. */
export function safeName(name: string): string {
  const cleaned = basename(name.replace(/\\/g, '/'))
    .replace(/[^\w.-]+/g, '_')
    .replace(/^\.+/, '');
  const trimmed = cleaned.length > 80 ? `${cleaned.slice(0, 60)}${cleaned.slice(-20)}` : cleaned;
  return trimmed || 'file';
}

/**
 * Saves a file dropped or pasted into a workspace's terminal and returns its path. A browser never
 * reveals where a dropped file lives, so the bytes are copied to a folder the terminal can read.
 */
export function saveUpload(root: string, sessionId: string, name: string, base64: string): string {
  if (!/^[\w-]{1,64}$/.test(sessionId)) throw new Error('bad session');
  // Four base64 characters carry three bytes.
  if (base64.length > Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 4) throw new Error('file too large');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_UPLOAD_BYTES) throw new Error('file too large');
  const dir = join(root, sessionId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // The random prefix keeps two files with one name apart.
  const path = join(dir, `${randomBytes(3).toString('hex')}-${safeName(name)}`);
  writeFileSync(path, bytes, { mode: 0o600 });
  return path;
}

/** Deletes uploads older than a week, so dropped files do not pile up. */
export function pruneUploads(root: string, now = Date.now()): void {
  let sessions: string[];
  try {
    sessions = readdirSync(root);
  } catch {
    return;
  }
  for (const session of sessions) {
    const dir = join(root, session);
    try {
      for (const file of readdirSync(dir)) {
        const path = join(dir, file);
        if (now - statSync(path).mtimeMs > RETENTION_MS) rmSync(path, { force: true });
      }
      if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to read.
    }
  }
}
