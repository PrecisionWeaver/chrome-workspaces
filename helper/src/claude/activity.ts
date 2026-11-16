import { ACTIVITY_LIMIT, type ActivityItem, buildActivity, parseActivityLine } from '../../../shared/sessions/activity';
import { StatCache } from './stat-cache';
import { tailLines } from './tail';

const TAIL_BYTES = 512 * 1024;

/** The recent turns of a claude session, from the event lines its hooks appended; empty when there are none. */
export function readActivity(path: string, limit = ACTIVITY_LIMIT): ActivityItem[] {
  // Every panel following a workspace is sent its turns on each change to the sessions folder, whichever session changed.
  return activities.get(
    path,
    () =>
      buildActivity(
        (tailLines(path, TAIL_BYTES) ?? []).flatMap((line) => parseActivityLine(line) ?? []),
        limit,
      ),
    `${limit}:${path}`,
  );
}

const activities = new StatCache<ActivityItem[]>();

/** Where a session's event lines are: beside its status file, named by the session. */
export function activityFile(sessionsDir: string, sessionId: string): string {
  return `${sessionsDir}/${sessionId}.events.jsonl`;
}

/** A subagent that never reported stopping (claude killed, say) stops counting as running after this long. */
const SUBAGENT_STALE_MS = 60 * 60 * 1000;

/**
 * Whether a subagent is still running, from the start and stop lines in a session's events. claude's own Stop does not
 * wait for a background subagent, so the status file alone says idle while one works.
 */
export function hasRunningSubagent(path: string, now = Date.now()): boolean {
  return runningSubagents.get(path, () => readRunningSubagent(path, now), path, now);
}

// The answer depends on the clock (a subagent goes stale), so an unchanged file is only trusted for a minute.
const runningSubagents = new StatCache<boolean>(60_000);

function readRunningSubagent(path: string, now: number): boolean {
  const running = new Map<string, number>();
  for (const line of tailLines(path, TAIL_BYTES) ?? []) {
    const event = parseActivityLine(line);
    if (!event) continue;
    if (event.event === 'SessionStart') running.clear();
    else if (event.event === 'SubagentStart' && event.agentId) running.set(event.agentId, Date.parse(event.at));
    else if (event.event === 'SubagentStop' && event.agentId) running.delete(event.agentId);
  }
  for (const started of running.values()) if (now - started < SUBAGENT_STALE_MS) return true;
  return false;
}
