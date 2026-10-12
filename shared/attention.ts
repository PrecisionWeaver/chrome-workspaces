import type { WorkspaceStatus } from './protocol';

export type AttentionKind = 'needs_input' | 'finished';

export interface AttentionEvent {
  id: string;
  kind: AttentionKind;
}

/** Workspaces whose claude is waiting on the user. */
export const needsInputCount = (statuses: Readonly<Record<string, WorkspaceStatus>>, ids: Iterable<string>): number => {
  let count = 0;
  for (const id of ids) if (statuses[id] === 'needs_input') count++;
  return count;
};

/**
 * What changed between two status snapshots that is worth telling the user: a workspace that started
 * waiting for input, or that went from working to idle (finished). A workspace seen for the first time
 * is never an event, so opening Chrome with sessions already waiting does not notify.
 */
export function attentionEvents(previous: Readonly<Record<string, WorkspaceStatus>>, next: Readonly<Record<string, WorkspaceStatus>>): AttentionEvent[] {
  const events: AttentionEvent[] = [];
  for (const [id, status] of Object.entries(next)) {
    if (!(id in previous)) continue;
    const before = previous[id];
    if (status === 'needs_input' && before !== 'needs_input') events.push({ id, kind: 'needs_input' });
    else if (status === 'idle' && before === 'working') events.push({ id, kind: 'finished' });
  }
  return events;
}
