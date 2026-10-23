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
 * Deals the cards into `count` columns. One column keeps their order. With more, the cards that need attention
 * go across the top, Usage and the workspace sessions head the first columns, and the rest are dealt out in turn,
 * so the same card stays in the same column from one refresh to the next, whatever the heights.
 */
export function layoutCards(cards: readonly HTMLElement[], count: number): CardLayout {
  if (count <= 1) return { top: [], columns: [[...cards]] };
  const key = (card: HTMLElement) => card.dataset.key ?? '';
  const top = cards.filter((card) => FULL_WIDTH.includes(key(card)));
  const rest = cards.filter((card) => !FULL_WIDTH.includes(key(card)));
  const lead = LEADING.flatMap((name) => rest.filter((card) => key(card) === name));
  const ordered = [...lead, ...rest.filter((card) => !LEADING.includes(key(card)))];
  const columns: HTMLElement[][] = Array.from({ length: count }, () => []);
  for (const [i, card] of ordered.entries()) columns[i % count].push(card);
  return { top, columns };
}
