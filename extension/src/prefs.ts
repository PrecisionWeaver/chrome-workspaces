export interface Prefs {
  /** Desktop notification when a workspace starts waiting for input or finishes. */
  notify: boolean;
}

const DEFAULTS: Prefs = { notify: false };

export async function loadPrefs(): Promise<Prefs> {
  const { prefs } = (await chrome.storage.local.get('prefs')) as { prefs?: Partial<Prefs> };
  return { ...DEFAULTS, ...prefs };
}

export async function savePrefs(change: Partial<Prefs>): Promise<Prefs> {
  const next = { ...(await loadPrefs()), ...change };
  await chrome.storage.local.set({ prefs: next });
  return next;
}

/** Calls `listener` with the new preferences whenever any context changes them. */
export function onPrefsChange(listener: (prefs: Prefs) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'prefs' in changes) listener({ ...DEFAULTS, ...(changes.prefs.newValue as Partial<Prefs> | undefined) });
  });
}
