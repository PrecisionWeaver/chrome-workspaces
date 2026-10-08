import type { Workspace } from '../../shared/protocol';

/** Which workspace each window shows when it holds several, by window id. Shared by every panel and the service worker. */
export type Selection = Record<string, string>;

const KEY = 'selectedByWindow';

export async function loadSelection(): Promise<Selection> {
  const stored = (await chrome.storage.local.get(KEY)) as { [KEY]?: Selection };
  return stored[KEY] ?? {};
}

export async function select(workspace: Workspace): Promise<void> {
  if (workspace.windowId === null) return;
  const selection = await loadSelection();
  if (selection[workspace.windowId] === workspace.id) return;
  await chrome.storage.local.set({ [KEY]: { ...selection, [workspace.windowId]: workspace.id } });
}

/** Calls `listener` with the new selection whenever any context changes it. */
export function onSelectionChange(listener: (selection: Selection) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEY in changes) listener((changes[KEY].newValue as Selection | undefined) ?? {});
  });
}

/** The workspace a window shows: the one selected in it if still there, else the first. */
export function shownIn(windowId: number | undefined, workspaces: readonly Workspace[], selection: Selection): Workspace | undefined {
  const here = workspaces.filter((ws) => ws.windowId === windowId);
  return here.find((ws) => ws.id === selection[String(windowId)]) ?? here[0];
}
