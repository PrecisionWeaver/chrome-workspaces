import { copyFileSync, statSync, truncateSync } from 'node:fs';

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Keeps helper.log from growing for as long as the agent runs. launchd holds the file open for
 * appending, so it cannot be renamed away: the old output is copied to `<file>.1` and the file is
 * emptied in place. One previous generation is kept.
 */
export function rotateLog(file: string, maxBytes = MAX_LOG_BYTES): boolean {
  try {
    if (statSync(file).size <= maxBytes) return false;
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
    return true;
  } catch {
    // No log yet, or not ours to change: logging is not worth stopping the helper for.
    return false;
  }
}
