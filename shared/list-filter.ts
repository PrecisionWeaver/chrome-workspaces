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
  const haystack = `${ws.name} ${ws.ticket ?? ''} ${ws.cwd} ${status ? STATUS_WORDS[status] : ''}${ws.pinned ? ' pinned' : ''}${ws.archived ? ' archived' : ''}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export interface ListSplit {
  /** Shown in the list, in order, with the number the switch shortcuts count them by. */
  active: { ws: Workspace; number: number }[];
  archived: Workspace[];
}

/**
 * Splits the list into what is shown and what is archived, filtered by `query`. Numbers count every
 * workspace that is not archived, whatever the filter, so a workspace keeps its number while searching.
 */
export function splitList(workspaces: readonly Workspace[], statuses: Readonly<Record<string, WorkspaceStatus>>, query: string): ListSplit {
  let number = 0;
  const active: ListSplit['active'] = [];
  const archived: Workspace[] = [];
  for (const ws of workspaces) {
    const matches = workspaceMatches(ws, statuses[ws.id], query);
    if (ws.archived) {
      if (matches) archived.push(ws);
    } else {
      number++;
      if (matches) active.push({ ws, number });
    }
  }
  return { active, archived };
}
