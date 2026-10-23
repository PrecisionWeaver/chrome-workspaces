/** Narrowest a card column may be, and the gap between columns; as many columns fit as the body is wide enough for, up to three. */
const COLUMN_MIN = 340;
const COLUMN_GAP = 12;
const MAX_COLUMNS = 3;

export function columnCountFor(width: number): number {
  const fit = Math.floor((width + COLUMN_GAP) / (COLUMN_MIN + COLUMN_GAP));
  return Math.min(MAX_COLUMNS, Math.max(1, fit));
}

/** Cards that need doing something about span the width above the columns when there are several. */
const FULL_WIDTH = ['Getting started', 'Needs attention'];

/** Cards that lead the columns when there are several, in order; the rest follow in their own order. */
const LEADING = ['Usage', 'Workspace sessions'];

export interface CardLayout {
  /** Cards above the columns, across the full width. */
  top: HTMLElement[];
  columns: HTMLElement[][];
}

/**
 * Deals the cards into `count` columns. The cards that need attention come first, then Usage and the workspace sessions,
 * then the rest: in one column that is the whole page. With more, the ones that need attention go across the top, Usage and
 * the workspace sessions head the first columns, and the rest are dealt out in turn,
 * or, given `heightOf`, each to the shortest column so far, which evens the columns out.
 */
export function layoutCards(cards: readonly HTMLElement[], count: number, heightOf?: (card: HTMLElement) => number): CardLayout {
  const key = (card: HTMLElement) => card.dataset.key ?? '';
  const top = cards.filter((card) => FULL_WIDTH.includes(key(card)));
  const rest = cards.filter((card) => !FULL_WIDTH.includes(key(card)));
  const lead = LEADING.flatMap((name) => rest.filter((card) => key(card) === name));
  const ordered = [...lead, ...rest.filter((card) => !LEADING.includes(key(card)))];
  // One column is the same order top to bottom, so what leads the columns still leads the page on a narrow panel.
  if (count <= 1) return { top: [], columns: [[...top, ...ordered]] };
  const columns: HTMLElement[][] = Array.from({ length: count }, () => []);
  if (!heightOf) {
    for (const [i, card] of ordered.entries()) columns[i % count].push(card);
    return { top, columns };
  }
  // The first card of each column is fixed, so Usage and the sessions lead whatever their heights. The tallest of the rest go
  // first, each to the shortest column so far, which evens the columns out far better than taking them in order; each column is
  // then put back in display order.
  const totals = new Array<number>(count).fill(0);
  const place = (card: HTMLElement, at: number) => {
    columns[at].push(card);
    totals[at] += heightOf(card);
  };
  for (const [i, card] of ordered.slice(0, count).entries()) place(card, i);
  for (const card of ordered.slice(count).sort((a, b) => heightOf(b) - heightOf(a))) place(card, totals.indexOf(Math.min(...totals)));
  for (const column of columns) column.sort((a, b) => ordered.indexOf(a) - ordered.indexOf(b));
  return { top, columns };
}

/** The layout a previous one chose, as the key of each card in each column, applied to the cards of this refresh. */
export function keysOf(layout: CardLayout): string[][] {
  return layout.columns.map((column) => column.map((card) => card.dataset.key ?? ''));
}

export function layoutFromKeys(cards: readonly HTMLElement[], keys: readonly (readonly string[])[]): CardLayout {
  const byKey = new Map(cards.map((card) => [card.dataset.key ?? '', card]));
  return {
    top: cards.filter((card) => FULL_WIDTH.includes(card.dataset.key ?? '')),
    columns: keys.map((column) => column.flatMap((key) => byKey.get(key) ?? [])),
  };
}
