import { DENSITIES, THEMES, type Density, type Theme } from '../../shared/keynav';
import { DEFAULT_USAGE_RANGE, USAGE_RANGES, type UsageRangeId } from '../../shared/usage';

export interface Prefs {
  /** Desktop notification when a workspace starts waiting for input or finishes. */
  notify: boolean;
  theme: Theme;
  density: Density;
  /** The setup checklist in Settings was dismissed. */
  setupDismissed: boolean;
  /** How far back the usage chart and its figures in Settings go. */
  usageRange: UsageRangeId;
}

const DEFAULTS: Prefs = { notify: false, theme: 'system', density: 'comfortable', setupDismissed: false, usageRange: DEFAULT_USAGE_RANGE };

/** Stored preferences with anything missing or invalid replaced by its default, since storage can hold anything. */
export function normalizePrefs(stored: unknown): Prefs {
  const p = (typeof stored === 'object' && stored !== null ? stored : {}) as Partial<Record<keyof Prefs, unknown>>;
  return {
    notify: p.notify === true,
    theme: THEMES.includes(p.theme as Theme) ? (p.theme as Theme) : DEFAULTS.theme,
    density: DENSITIES.includes(p.density as Density) ? (p.density as Density) : DEFAULTS.density,
    setupDismissed: p.setupDismissed === true,
    usageRange: USAGE_RANGES.some((range) => range.id === p.usageRange) ? (p.usageRange as UsageRangeId) : DEFAULT_USAGE_RANGE,
  };
}

export async function loadPrefs(): Promise<Prefs> {
  const { prefs } = await chrome.storage.local.get('prefs');
  return normalizePrefs(prefs);
}

export async function savePrefs(change: Partial<Prefs>): Promise<Prefs> {
  const next = { ...(await loadPrefs()), ...change };
  await chrome.storage.local.set({ prefs: next });
  return next;
}

/** Calls `listener` with the new preferences whenever any context changes them. */
export function onPrefsChange(listener: (prefs: Prefs) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'prefs' in changes) listener(normalizePrefs(changes.prefs.newValue));
  });
}
