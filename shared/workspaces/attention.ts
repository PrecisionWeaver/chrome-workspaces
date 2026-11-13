import type { WaitingOn, WorkspaceStatus } from '../protocol/protocol';

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

export type WaitingKind = 'permission' | 'question';

export interface WaitingDescription {
  kind: WaitingKind;
  /** For a notification: "<name> needs your permission" or "<name> needs your input". */
  title: string;
  /** Claude's own words, when the hook had them. */
  message: string;
}

/** Whether a waiting workspace wants a permission answered or anything else (a question, a dialog). */
export const waitingKind = (waiting: WaitingOn | null | undefined): WaitingKind => (waiting?.type === 'permission_prompt' ? 'permission' : 'question');

/** What to tell the user about a workspace that is waiting. */
export function describeWaiting(name: string, waiting: WaitingOn | null | undefined): WaitingDescription {
  const kind = waitingKind(waiting);
  return {
    kind,
    title: kind === 'permission' ? `${name} needs your permission` : `${name} needs your input`,
    message: waiting?.message || 'Claude is waiting for you.',
  };
}

/** A status in a word or two, for chips, labels and hints: a wait for a permission is named as such. */
export function statusLabel(status: WorkspaceStatus | null | undefined, waiting: WaitingOn | null | undefined): string {
  if (status === 'needs_input') return waitingKind(waiting) === 'permission' ? 'needs permission' : 'needs input';
  return status ?? '';
}
