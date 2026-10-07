import type { ControlToHelper, Workspace } from '../../shared/protocol';

type Bounds = Pick<chrome.windows.Window, 'left' | 'top' | 'width' | 'height'>;
type SharedSize = { maximized: true } | Bounds;

/** Whichever workspace window was last moved, resized or maximized sets the size they all share. */
export function recordSharedSize(window: chrome.windows.Window): void {
  if (window.type !== 'normal') return;
  let sharedSize: SharedSize;
  if (window.state === 'maximized') sharedSize = { maximized: true };
  else if (window.state === 'normal') sharedSize = { left: window.left, top: window.top, width: window.width, height: window.height };
  else return;
  // Stored rather than held in memory because the service worker can be stopped at any time.
  void chrome.storage.local.set({ sharedSize });
}

async function sizeOptions(): Promise<chrome.windows.UpdateInfo> {
  const { sharedSize } = (await chrome.storage.local.get('sharedSize')) as { sharedSize?: SharedSize };
  if (!sharedSize) return {};
  return 'maximized' in sharedSize ? { state: 'maximized' } : { state: 'normal', ...sharedSize };
}

async function windowExists(windowId: number): Promise<boolean> {
  try {
    await chrome.windows.get(windowId);
    return true;
  } catch {
    return false;
  }
}

/** Brings the workspace's window forward at the shared size, opening one if it has none. Returns its window id. */
export async function switchTo(workspace: Workspace, send: (message: ControlToHelper) => boolean): Promise<number | undefined> {
  if (workspace.windowId !== null && (await windowExists(workspace.windowId))) {
    await chrome.windows.update(workspace.windowId, { focused: true, ...(await sizeOptions()) });
    return workspace.windowId;
  }
  return openWindow(workspace, send);
}

export async function openWindow(workspace: Workspace, send: (message: ControlToHelper) => boolean): Promise<number | undefined> {
  const size = await sizeOptions();
  const created = await chrome.windows.create({
    url: workspace.lastTabUrls.length ? workspace.lastTabUrls : (workspace.url ?? undefined),
    focused: true,
    ...(size.state === 'maximized' ? {} : size),
  });
  if (created?.id === undefined) return undefined;
  if (size.state === 'maximized') await chrome.windows.update(created.id, { state: 'maximized' });
  send({ type: 'pair', id: workspace.id, windowId: created.id });
  return created.id;
}
