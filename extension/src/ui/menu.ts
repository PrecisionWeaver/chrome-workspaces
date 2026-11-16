let current: HTMLDivElement | null = null;
// What had focus when the menu opened, so closing it hands the keyboard back there.
let opener: HTMLElement | null = null;

export function closeMenu(): void {
  if (!current) return;
  const hadFocus = current.contains(document.activeElement);
  current.remove();
  current = null;
  if (hadFocus && opener?.isConnected) opener.focus();
  opener = null;
}

const enabledItems = (menu: HTMLElement): HTMLButtonElement[] => [...menu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];

/** A button for a menu: one line of text that closes the menu and then does its thing. */
export function menuItem(label: string, run: () => void, options: { title?: string; checked?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  button.textContent = options.checked ? `✓ ${label}` : label;
  if (options.title) button.title = options.title;
  button.disabled = options.disabled === true;
  button.addEventListener('click', () => {
    closeMenu();
    run();
  });
  return button;
}

/**
 * Shows a floating menu at a point, kept inside the panel, until something else is clicked, Escape is
 * pressed or the panel loses focus. Only one is open at a time. `className` adds to the menu's own.
 */
export function openMenu(x: number, y: number, children: readonly Node[], className = ''): HTMLDivElement {
  closeMenu();
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const menu = document.createElement('div');
  menu.className = `popup-menu ${className}`.trim();
  menu.setAttribute('role', 'menu');
  menu.append(...children);
  document.body.append(menu);
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
  current = menu;
  // The keyboard goes into the menu, so every item can be reached and chosen without the mouse.
  enabledItems(menu)[0]?.focus();
  return menu;
}

document.addEventListener('mousedown', (event) => {
  if (current && !current.contains(event.target as Node)) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (!current) return;
  if (event.key === 'Escape') {
    closeMenu();
    return;
  }
  if (event.key === 'Tab') {
    // Tabbing out of a menu closes it, as a native one does.
    closeMenu();
    return;
  }
  const items = enabledItems(current);
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === 'ArrowDown' ? at + 1 : event.key === 'ArrowUp' ? at - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : null;
  if (next === null || items.length === 0) return;
  event.preventDefault();
  items[(next + items.length) % items.length].focus();
});
window.addEventListener('blur', closeMenu);
