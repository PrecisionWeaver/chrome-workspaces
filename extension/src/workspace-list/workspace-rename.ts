import type { Workspace } from '../../../shared/protocol/workspace';

/**
 * Swaps a workspace's name for a box to rename it in. Enter or leaving the box saves (a blank or unchanged name
 * does not), Escape discards; either way `onDone` runs once, so the list can be drawn again.
 */
export function startRename(ws: Workspace, nameEl: HTMLElement, rename: (name: string) => void, onDone: () => void): void {
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = ws.name;
  input.maxLength = 80;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (save && name && name !== ws.name) rename(name);
    onDone();
  };
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    else if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (event) => event.stopPropagation());
}
