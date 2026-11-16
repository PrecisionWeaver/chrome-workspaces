const matches = (node: HTMLElement, key: string): boolean => node.dataset.focus === key || node.dataset.id === key;

/**
 * Runs a redraw of `root` and puts keyboard focus back on the element that had it. A view that redraws on a
 * timer or on every status change would otherwise drop focus from a button between two presses, so a two-click
 * confirm could not be finished from the keyboard. Elements are found again by `data-focus` (or `data-id`).
 */
export function keepFocus(root: HTMLElement, redraw: () => void): void {
  const active = document.activeElement;
  const key = active instanceof HTMLElement && root.contains(active) ? (active.dataset.focus ?? active.dataset.id) : undefined;
  redraw();
  if (key) [...root.querySelectorAll<HTMLElement>('[data-focus], [data-id]')].find((node) => matches(node, key))?.focus();
}
