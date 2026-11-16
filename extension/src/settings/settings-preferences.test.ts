// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../../testing/chrome-mock';
import { normalizePrefs, type Prefs } from '../app/prefs';
import type { PrefsHandle } from './settings-parts';
import { preferencesCard } from './settings-preferences';

let prefs: Prefs;
let changes: Partial<Prefs>[];
const handle: PrefsHandle = {
  get: () => prefs,
  set(change) {
    changes.push(change);
    prefs = { ...prefs, ...change };
  },
};

beforeEach(() => {
  installChrome();
  prefs = normalizePrefs(undefined);
  changes = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('preferencesCard', () => {
  it('shows the bound shortcut, or says there is none, with a way to change it', () => {
    expect(preferencesCard(handle, '⌘⇧Y').textContent).toContain('⌘⇧Y');
    const card = preferencesCard(handle, '');
    expect(card.textContent).toContain('not bound');
    (card.querySelector('.kv button') as HTMLButtonElement).click();
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'chrome://extensions/shortcuts' });
  });

  it('saves a theme, a density and the notifications switch as each is changed', () => {
    const card = preferencesCard(handle, '');
    const selects = [...card.querySelectorAll<HTMLSelectElement>('select')];
    selects[0]!.value = 'light';
    selects[0]!.dispatchEvent(new Event('change'));
    selects[1]!.value = 'compact';
    selects[1]!.dispatchEvent(new Event('change'));
    const box = card.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    expect(changes).toEqual([{ theme: 'light' }, { density: 'compact' }, { notify: true }]);
  });

  it('starts each control from the saved value', () => {
    prefs = { ...prefs, theme: 'dark', density: 'compact', notify: true };
    const card = preferencesCard(handle, '');
    const selects = [...card.querySelectorAll<HTMLSelectElement>('select')];
    expect(selects.map((select) => select.value)).toEqual(['dark', 'compact']);
    expect(card.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(true);
  });
});
