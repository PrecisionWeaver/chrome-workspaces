import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/**
 * The lines at the end of a file, oldest first. Only the last `bytes` are read, since the files this reads
 * (transcripts, event logs) grow large; a tail that starts mid-file drops the partial line it begins with.
 * Null when the file cannot be read.
 */
export function tailLines(path: string, bytes: number): string[] | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (size > length) lines.shift();
    return lines;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
