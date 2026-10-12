import { fuzzyRank } from '../../shared/fuzzy';
import { el } from './dom';

export interface PaletteItem {
  /** What the item is, shown as a small label and used to group results. */
  kind: string;
  label: string;
  /** Secondary text, e.g. a workspace's directory or a PR's author. */
  hint?: string;
  run(): void;
}

export interface Palette {
  readonly isOpen: boolean;
  open(): void;
  close(): void;
}

const MAX_RESULTS = 60;

/** A ⌘K box that filters everything the panel can do or open. `items` is read each time it opens. */
export function createPalette(items: () => PaletteItem[], onClose: () => void): Palette {
  const root = document.getElementById('palette') as HTMLElement;
  const input = document.getElementById('palette-input') as HTMLInputElement;
  const list = document.getElementById('palette-results') as HTMLUListElement;

  let all: PaletteItem[] = [];
  let shown: PaletteItem[] = [];
  let active = 0;
  let isOpen = false;

  function render(): void {
    shown = fuzzyRank(input.value, all, (item) => `${item.label} ${item.kind}`)
      .slice(0, MAX_RESULTS)
      .map((r) => r.item);
    active = Math.min(active, Math.max(shown.length - 1, 0));
    list.replaceChildren(
      ...shown.map((item, index) => {
        const row = el('li', '', `palette-row${index === active ? ' active' : ''}`);
        row.setAttribute('role', 'option');
        row.append(el('span', item.kind, 'palette-kind'), el('span', item.label, 'palette-label'));
        if (item.hint) row.append(el('span', item.hint, 'palette-hint'));
        row.addEventListener('mousemove', () => {
          if (active === index) return;
          active = index;
          highlight();
        });
        row.addEventListener('click', () => choose(index));
        return row;
      }),
    );
    if (shown.length === 0) list.append(el('li', 'Nothing matches', 'palette-empty'));
  }

  function highlight(): void {
    [...list.children].forEach((row, index) => row.classList.toggle('active', index === active));
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }

  function choose(index: number): void {
    const item = shown[index];
    if (!item) return;
    close();
    item.run();
  }

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    all = items();
    input.value = '';
    active = 0;
    root.hidden = false;
    render();
    input.focus();
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    root.hidden = true;
    onClose();
  }

  input.addEventListener('input', () => {
    active = 0;
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) active = Math.min(active + 1, shown.length - 1);
    else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) active = Math.max(active - 1, 0);
    else if (event.key === 'Enter') choose(active);
    else if (event.key === 'Escape') close();
    else return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key.startsWith('Arrow') || event.ctrlKey) highlight();
  });
  // Clicking the dimmed area outside the box dismisses it.
  root.addEventListener('mousedown', (event) => {
    if (event.target === root) close();
  });

  return {
    get isOpen() {
      return isOpen;
    },
    open,
    close,
  };
}
