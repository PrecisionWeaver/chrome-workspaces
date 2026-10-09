import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { eventsFromLine, type TimelineEvent } from '../../shared/timeline';

const TAIL_BYTES = 768 * 1024;
export const TIMELINE_LIMIT = 80;

/**
 * The most recent things that happened in a claude transcript, oldest first. Only the end of the file
 * is read, since transcripts grow large, so a very busy session's earlier history is not reachable.
 */
export function readTimeline(path: string, limit = TIMELINE_LIMIT): TimelineEvent[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const { size } = fstatSync(fd);
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // A tail that starts mid-file begins with a partial line.
    if (size > length) lines.shift();
    return lines.flatMap(eventsFromLine).slice(-limit);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
