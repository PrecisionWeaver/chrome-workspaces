import { $ } from './dom';

/** The part of xterm's search addon the box uses. */
export interface Searcher {
  findNext(term: string, options?: { incremental?: boolean }): boolean;
  findPrevious(term: string, options?: { incremental?: boolean }): boolean;
  clearDecorations(): void;
}

export interface TerminalSearch {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
}

/** A find box over the terminal: typing finds as you go, Enter and Shift+Enter step through matches, Escape closes. */
export function createTerminalSearch(search: Searcher, focusTerminal: () => void): TerminalSearch {
  const box = $<HTMLDivElement>('term-search');
  const input = $<HTMLInputElement>('term-search-input');

  function close(): void {
    if (box.hidden) return;
    box.hidden = true;
    search.clearDecorations();
    focusTerminal();
  }

  function open(): void {
    box.hidden = false;
    input.focus();
    input.select();
  }

  input.addEventListener('input', () => {
    if (input.value) search.findNext(input.value, { incremental: true });
    else search.clearDecorations();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!input.value) return;
      if (event.shiftKey) search.findPrevious(input.value, { incremental: false });
      else search.findNext(input.value, { incremental: false });
    }
  });
  $<HTMLButtonElement>('term-search-prev').addEventListener('click', () => input.value && search.findPrevious(input.value, { incremental: false }));
  $<HTMLButtonElement>('term-search-next').addEventListener('click', () => input.value && search.findNext(input.value, { incremental: false }));
  $<HTMLButtonElement>('term-search-close').addEventListener('click', close);

  return {
    open,
    close,
    get isOpen() {
      return !box.hidden;
    },
  };
}
