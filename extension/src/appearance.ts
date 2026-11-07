import { resolveTheme } from '../../shared/keynav';
import { loadPrefs, onPrefsChange, type Prefs } from './prefs';

/**
 * Applies the theme and density to the page now, and again whenever they change; `system` follows the operating system.
 * `apply` is called alongside with the resolved theme, for what the page's styles cannot reach (the terminals).
 */
export function followAppearance(apply: (theme: 'dark' | 'light') => void): void {
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  let current: Prefs | null = null;
  const update = (prefs: Prefs | null = current): void => {
    if (!prefs) return;
    current = prefs;
    const theme = resolveTheme(prefs.theme, systemDark.matches);
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.density = prefs.density;
    apply(theme);
  };
  void loadPrefs().then(update);
  onPrefsChange(update);
  systemDark.addEventListener('change', () => update());
}
