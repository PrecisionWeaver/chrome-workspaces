import { describe, expect, it } from 'vitest';
import { normalizePrefs } from '../../extension/src/prefs';

describe('normalizePrefs', () => {
  it('fills defaults for nothing, and for anything that is not an object', () => {
    const defaults = { notify: false, theme: 'system', density: 'comfortable', setupDismissed: false };
    for (const stored of [undefined, null, 'dark', 7, []]) expect(normalizePrefs(stored)).toEqual(defaults);
  });

  it('keeps valid values and replaces invalid ones with their defaults, field by field', () => {
    expect(normalizePrefs({ notify: true, theme: 'light', density: 'compact', setupDismissed: true })).toEqual({ notify: true, theme: 'light', density: 'compact', setupDismissed: true });
    expect(normalizePrefs({ notify: 'yes', theme: 'neon', density: 'tiny' })).toEqual({ notify: false, theme: 'system', density: 'comfortable', setupDismissed: false });
    expect(normalizePrefs({ theme: 'dark' })).toEqual({ notify: false, theme: 'dark', density: 'comfortable', setupDismissed: false });
  });
});
