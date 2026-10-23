import { ACTIVITY_LIMIT, type ActivityItem, buildActivity, parseActivityLine } from '../../shared/activity';
import { tailLines } from './tail';

const TAIL_BYTES = 512 * 1024;

/** The recent turns of a claude session, from the event lines its hooks appended; empty when there are none. */
export function readActivity(path: string, limit = ACTIVITY_LIMIT): ActivityItem[] {
  const lines = tailLines(path, TAIL_BYTES) ?? [];
  return buildActivity(
    lines.flatMap((line) => parseActivityLine(line) ?? []),
    limit,
  );
}

/** Where a session's event lines are: beside its status file, named by the session. */
export function activityFile(sessionsDir: string, sessionId: string): string {
  return `${sessionsDir}/${sessionId}.events.jsonl`;
}
