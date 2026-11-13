import { isAbsolute } from 'node:path';
import type { WebSocket } from 'ws';
import { errorMessage } from '../../../shared/protocol/errors';
import type { ControlToHelper } from '../../../shared/protocol/protocol';
import { prWorkspace } from '../git/pr-workspace';
import { isDirectory } from '../platform/config';
import type { HubContext } from './hub';

export type WorkspaceRequest = Extract<ControlToHelper, { type: 'create' | 'rename' | 'move' | 'mark' | 'order' | 'restore' | 'forget' | 'forgetAll' }>;

const WORKSPACE_REQUESTS: ReadonlySet<string> = new Set(['create', 'rename', 'move', 'mark', 'order', 'restore', 'forget', 'forgetAll']);

export function isWorkspaceRequest(message: ControlToHelper): message is WorkspaceRequest {
  return WORKSPACE_REQUESTS.has(message.type);
}

/** Changes the list of workspaces, or the archive, as a client asks; the store's change event then carries the new state to everyone. */
export function handleWorkspace(hub: HubContext, message: WorkspaceRequest, ws: WebSocket): void {
  const { store, history } = hub.options;
  switch (message.type) {
    case 'create':
      createWorkspace(hub, message, ws).catch((error: unknown) =>
        hub.sendTo(ws, {
          type: 'createError',
          name: message.name.trim(),
          message: `Could not create the workspace: ${errorMessage(error)}`,
        }),
      );
      break;
    case 'rename':
      if (store.get(message.id)) store.rename(message.id, message.name.trim());
      break;
    case 'move':
      if (store.get(message.id)) store.move(message.id, message.index);
      break;
    case 'mark':
      if (store.get(message.id)) store.mark(message.id, message);
      break;
    case 'order':
      store.reorder(message.ids);
      break;
    case 'restore':
      restoreWorkspace(hub, message);
      break;
    case 'forget':
      history.remove(message.historyId);
      break;
    case 'forgetAll':
      history.clear();
      break;
  }
}

async function createWorkspace(hub: HubContext, message: Extract<ControlToHelper, { type: 'create' }>, ws: WebSocket): Promise<void> {
  const { store, defaultCwd, repoDirs, reviews, git } = hub.options;
  const existing = message.pr ? store.findByPr(message.pr) : undefined;
  if (existing) {
    hub.send({ type: 'focus', id: existing.id });
    return;
  }
  const chosen = message.cwd && isAbsolute(message.cwd) && isDirectory(message.cwd) ? message.cwd : null;
  // A PR workspace starts in its repo's configured directory unless one was picked.
  const base = message.pr ? prWorkspace(message.pr, { reviews: reviews.state().items, repoDirs, defaultCwd }) : { cwd: defaultCwd };
  if (chosen) base.cwd = chosen;
  if (message.worktree) {
    try {
      base.cwd = await git.addWorktree(base.cwd, message.worktree);
    } catch (error) {
      const reason = errorMessage(error);
      hub.sendTo(ws, { type: 'createError', name: message.name.trim(), message: `Could not make a worktree for ${message.worktree}: ${reason}` });
      return;
    }
  }
  const workspace = store.create({
    ...base,
    name: message.name.trim(),
    prompt: message.prompt?.trim() || null,
    model: message.model ?? null,
    color: message.color ?? null,
    tabs: message.urls ?? [],
  });
  if (message.windowId === null) hub.send({ type: 'open', id: workspace.id });
  else {
    store.pairWindow(workspace.id, message.windowId);
    // A workspace joining a window another one holds gets its own tab group there.
    if (message.group) hub.send({ type: 'group', id: workspace.id });
  }
}

/** Brings an archived workspace back, in the window asked for or a new one, and drops it from the archive. */
function restoreWorkspace(hub: HubContext, message: Extract<ControlToHelper, { type: 'restore' }>): void {
  const { store, history, defaultCwd } = hub.options;
  const entry = history.get(message.historyId);
  if (!entry) return;
  // The directory may be gone, e.g. a deleted worktree; the default directory is better than none.
  const cwd = isDirectory(entry.cwd) ? entry.cwd : defaultCwd;
  const workspace = store.create({
    name: entry.name,
    ticket: entry.ticket,
    cwd,
    url: entry.url,
    pr: entry.pr,
    model: entry.model,
    tabs: entry.tabs,
    resume: entry.resumeId,
  });
  history.remove(entry.id);
  if (entry.pinned || entry.color) store.mark(workspace.id, { pinned: entry.pinned, color: entry.color });
  if (message.windowId === null) hub.send({ type: 'open', id: workspace.id });
  else {
    store.pairWindow(workspace.id, message.windowId);
    // The window already holds a workspace, so this one gets its own tab group there, with its tabs.
    hub.send({ type: 'group', id: workspace.id });
  }
}
