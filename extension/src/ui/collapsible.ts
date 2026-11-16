/**
 * Makes `toggle` collapse and expand `section` (the `collapsed` class), remembers the choice under `storageKey` in
 * `chrome.storage.local`, and keeps the button's `aria-expanded` and its "Collapse …" / "Expand …" label true. The
 * noun for the label is what follows "Collapse " in the button's own `aria-label`. `onChange` runs after a click and
 * once the saved state has been applied.
 */
export function collapsible(options: { section: HTMLElement; toggle: HTMLElement; storageKey: string; onChange?: (collapsed: boolean) => void }): void {
  const { section, toggle, storageKey, onChange } = options;
  const noun = (toggle.getAttribute('aria-label') ?? '').replace(/^(Collapse|Expand) /, '');
  const show = (collapsed: boolean): void => {
    section.classList.toggle('collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const label = `${collapsed ? 'Expand' : 'Collapse'} ${noun}`;
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
  };
  show(section.classList.contains('collapsed'));
  toggle.addEventListener('click', () => {
    const collapsed = !section.classList.contains('collapsed');
    show(collapsed);
    void chrome.storage.local.set({ [storageKey]: collapsed });
    onChange?.(collapsed);
  });
  void chrome.storage.local.get(storageKey).then((saved) => {
    show(saved[storageKey] === true);
    onChange?.(saved[storageKey] === true);
  });
}
