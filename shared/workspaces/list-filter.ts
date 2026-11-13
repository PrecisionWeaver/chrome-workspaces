import { waitingKind } from './attention';
import type { WaitingOn, Workspace, WorkspaceStatus } from '../protocol/protocol';

const STATUS_WORDS: Record<NonNullable<WorkspaceStatus>, string> = {
  needs_input: 'waiting needs input',
  working: 'working busy',
  idle: 'idle',
};

/** Every word of the query must appear in the workspace's name, ticket, directory, status, or what it is waiting on. */
export function workspaceMatches(ws: Workspace, status: WorkspaceStatus | undefined, query: string, waiting?: WaitingOn | null): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const wanted = status === 'needs_input' && waiting ? ` ${waitingKind(waiting)} ${waiting.message}` : '';
  const haystack = `${ws.name} ${ws.ticket ?? ''} ${ws.cwd} ${status ? STATUS_WORDS[status] : ''}${wanted}${ws.pinned ? ' pinned' : ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export interface ListRow {
  ws: Workspace;
  /** What the switch shortcuts count the workspace by. */
  number: number;
}

/** The workspaces matching `query`, in order. Numbers count every workspace, whatever the filter, so one keeps its number while searching. */
export function filterList(
  workspaces: readonly Workspace[],
  statuses: Readonly<Record<string, WorkspaceStatus>>,
  query: string,
  waiting: Readonly<Record<string, WaitingOn>> = {},
): ListRow[] {
  return workspaces.flatMap((ws, index) => (workspaceMatches(ws, statuses[ws.id], query, waiting[ws.id]) ? [{ ws, number: index + 1 }] : []));
}
