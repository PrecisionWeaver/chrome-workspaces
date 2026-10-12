import type { Workspace, WorkspaceStatus } from './protocol';

const STATUS_WORDS: Record<NonNullable<WorkspaceStatus>, string> = {
  needs_input: 'waiting needs input',
  working: 'working busy',
  idle: 'idle',
};

/** Every word of the query must appear in the workspace's name, ticket, directory or status. */
export function workspaceMatches(ws: Workspace, status: WorkspaceStatus | undefined, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = `${ws.name} ${ws.ticket ?? ''} ${ws.cwd} ${status ? STATUS_WORDS[status] : ''}${ws.pinned ? ' pinned' : ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export interface ListRow {
  ws: Workspace;
  /** What the switch shortcuts count the workspace by. */
  number: number;
}

/** The workspaces matching `query`, in order. Numbers count every workspace, whatever the filter, so one keeps its number while searching. */
export function filterList(workspaces: readonly Workspace[], statuses: Readonly<Record<string, WorkspaceStatus>>, query: string): ListRow[] {
  return workspaces.flatMap((ws, index) => (workspaceMatches(ws, statuses[ws.id], query) ? [{ ws, number: index + 1 }] : []));
}
