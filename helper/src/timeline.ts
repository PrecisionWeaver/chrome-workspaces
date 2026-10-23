import { eventsFromLine, type TimelineEvent } from '../../shared/timeline';
import { tailLines } from './tail';

const TAIL_BYTES = 768 * 1024;
export const TIMELINE_LIMIT = 80;

/**
 * The most recent things that happened in a claude transcript, oldest first. Only the end of the file
 * is read, since transcripts grow large, so a very busy session's earlier history is not reachable.
 */
export function readTimeline(path: string, limit = TIMELINE_LIMIT): TimelineEvent[] {
  return (tailLines(path, TAIL_BYTES) ?? []).flatMap(eventsFromLine).slice(-limit);
}
