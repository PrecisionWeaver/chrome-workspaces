/** The same shape the helper accepts for a session id in `/attach`. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

const PAGE = 'popout.html';

/** The address of the pop-out page for a workspace; `base` is the extension's root URL (`chrome.runtime.getURL('')`). */
export function popoutUrl(base: string, id: string): string {
  return `${base}${PAGE}?ws=${encodeURIComponent(id)}`;
}

/** The workspace a pop-out page was opened for, or null when the address is not a pop-out or names no valid id. */
export function popoutWorkspaceId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!parsed.pathname.endsWith(`/${PAGE}`)) return null;
  const id = parsed.searchParams.get('ws');
  return id !== null && SESSION_ID.test(id) ? id : null;
}

/** The open window already showing the workspace, so asking again brings it forward rather than opening a second. */
export function findPopout<W extends { tabs?: { url?: string }[] }>(windows: W[], base: string, id: string): W | undefined {
  const wanted = popoutUrl(base, id);
  return windows.find((win) => win.tabs?.some((tab) => tab.url === wanted));
}
