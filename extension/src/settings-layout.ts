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

/**
 * The cards that lead each column, by how many columns there are: Plan usage sits under Usage in one and two columns,
 * and heads the third when there are three. In one column the list is the whole page, in this order.
 */
const LEADING: Record<number, string[][]> = {
  1: [['Usage', 'Plan usage', 'Workspaces']],
  2: [['Usage', 'Plan usage'], ['Workspaces']],
  3: [['Usage'], ['Workspaces'], ['Plan usage']],
};

export interface CardLayout {
  /** Cards above the columns, across the full width. */
  top: HTMLElement[];
  columns: HTMLElement[][];
}

/**
 * Deals the cards into `count` columns. The cards that need attention go across the top (first, in one column), the leading
 * cards open the columns as `LEADING` says, and the rest are dealt to whichever column has the fewest cards or, given
 * `heightOf`, the least height, tallest first, which evens the columns out far better than taking them in order.
 * Each column is then put back in display order.
 */
export function layoutCards(cards: readonly HTMLElement[], count: number, heightOf?: (card: HTMLElement) => number): CardLayout {
  const key = (card: HTMLElement) => card.dataset.key ?? '';
  const top = cards.filter((card) => FULL_WIDTH.includes(key(card)));
  const rest = cards.filter((card) => !FULL_WIDTH.includes(key(card)));
  const lead = (LEADING[Math.min(count, 3)] ?? LEADING[3]).map((names) => names.flatMap((name) => rest.filter((card) => key(card) === name)));
  const led = new Set(lead.flat());
  const others = rest.filter((card) => !led.has(card));
  const ordered = [...lead.flat(), ...others];
  // One column is the same order top to bottom, so what leads the columns still leads the page on a narrow panel.
  if (count <= 1) return { top: [], columns: [[...top, ...ordered]] };

  // A leading column that has nothing to hold is skipped, so the cards that are there open the first columns.
  const columns: HTMLElement[][] = lead.filter((column) => column.length > 0);
  while (columns.length < count) columns.push([]);
  const height = (card: HTMLElement) => heightOf?.(card) ?? 0;
  const totals = columns.map((column) => column.reduce((sum, card) => sum + height(card), 0));
  const shortest = () => (heightOf ? totals.indexOf(Math.min(...totals)) : columns.findIndex((c) => c.length === Math.min(...columns.map((x) => x.length))));
  for (const card of heightOf ? [...others].sort((a, b) => height(b) - height(a)) : others) {
    const at = shortest();
    columns[at].push(card);
    totals[at] += height(card);
  }
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
