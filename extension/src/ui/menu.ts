let current: HTMLDivElement | null = null;

export function closeMenu(): void {
  current?.remove();
  current = null;
}

/** A button for a menu: one line of text that closes the menu and then does its thing. */
export function menuItem(label: string, run: () => void, options: { title?: string; checked?: boolean; disabled?: boolean } = {}): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
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
  const menu = document.createElement('div');
  menu.className = `popup-menu ${className}`.trim();
  menu.setAttribute('role', 'menu');
  menu.append(...children);
  document.body.append(menu);
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
  current = menu;
  return menu;
}

document.addEventListener('mousedown', (event) => {
  if (current && !current.contains(event.target as Node)) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeMenu();
});
window.addEventListener('blur', closeMenu);
