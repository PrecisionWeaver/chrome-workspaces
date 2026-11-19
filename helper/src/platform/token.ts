import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadOrCreateToken(dir: string): string {
  const file = join(dir, 'token');
  if (existsSync(file)) {
    // A token restored from a backup, or left by an older version, may be readable by others: only its owner should read it.
    chmodSync(file, 0o600);
    return readFileSync(file, 'utf8').trim();
  }

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}
