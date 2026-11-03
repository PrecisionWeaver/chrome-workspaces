/**
 * Where arrow-key navigation lands in a list of `count` rows, from `current` (-1 when none has focus).
 * Returns null for a key that is not navigation. It stops at the ends rather than wrapping, so holding a
 * key does not loop forever.
 */
export function nextIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
    case 'j':
      return current < 0 ? 0 : Math.min(current + 1, count - 1);
    case 'ArrowUp':
    case 'k':
      return current < 0 ? count - 1 : Math.max(current - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

export type Theme = 'system' | 'dark' | 'light';
export type Density = 'comfortable' | 'compact';

export const THEMES: readonly Theme[] = ['system', 'dark', 'light'];
export const DENSITIES: readonly Density[] = ['comfortable', 'compact'];

/** Terminal font sizes on offer, in px. */
export const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18] as const;
export type FontSize = (typeof FONT_SIZES)[number];
export const DEFAULT_FONT_SIZE: FontSize = 12;

/** The theme to draw: `system` follows the operating system's setting. */
export const resolveTheme = (theme: Theme, systemPrefersDark: boolean): 'dark' | 'light' =>
  theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : theme;
