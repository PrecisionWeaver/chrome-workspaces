import { DENSITIES, THEMES } from '../../../shared/lib/keynav';
import { el } from '../ui/dom';
import { card, plain, type PrefsHandle, row } from './settings-parts';

function checkbox(label: string, checked: boolean, onChange: (value: boolean) => void, hint = ''): HTMLElement {
  const wrapper = el('label', '', 'pref');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  wrapper.append(box, el('span', label, 'pref-label'));
  if (hint) wrapper.append(el('span', hint, 'pref-hint'));
  return wrapper;
}

function choice<T extends string>(label: string, values: readonly T[], current: T, onChange: (value: T) => void): HTMLElement {
  const wrapper = el('label', '', 'pref');
  const select = el('select', '', 'pref-select');
  select.append(...values.map((value) => Object.assign(el('option', value[0].toUpperCase() + value.slice(1)), { value, selected: value === current })));
  select.addEventListener('change', () => onChange(select.value as T));
  wrapper.append(el('span', label, 'pref-label'), select);
  return wrapper;
}

/** Shortcut, theme, density and notifications; each change is saved as it is made. */
export function preferencesCard(prefs: PrefsHandle, switchShortcut: string): HTMLElement {
  const change = plain('Change', () => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }), "Chrome's shortcuts page, where the keys are bound");
  const shortcut = row('Switch workspaces', switchShortcut || 'not bound');
  shortcut.append(change);
  // These keys work anywhere in the panel but are bound in code, so nothing else on screen mentions them.
  const keys = row('Keys', '⌘K palette · ⌘F find · ⌘I terminal · ⇧⏎ new line');
  keys.title =
    'Ctrl instead of ⌘ outside macOS. ⌘K opens the command palette, which finds every workspace and action; ⇧⏎ types a new line in claude without sending.';
  return card(
    'Preferences',
    shortcut,
    keys,
    choice('Theme', THEMES, prefs.get().theme, (theme) => {
      prefs.set({ theme });
    }),
    choice('Density', DENSITIES, prefs.get().density, (density) => {
      prefs.set({ density });
    }),
    checkbox(
      'Desktop notifications',
      prefs.get().notify,
      (notify) => prefs.set({ notify }),
      'When a workspace starts waiting for input or finishes. The toolbar icon always shows how many are waiting.',
    ),
  );
}
