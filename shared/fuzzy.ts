/**
 * Scores how well `query` matches `text` as a subsequence, higher being better, or null when it does not
 * match. Characters that start a word, follow the previous match directly, or sit early score more, so
 * "nw" finds "New workspace" before "Draft: new window".
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return 0;
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, from);
    if (at === -1) return null;
    const startsWord = at === 0 || /[\s\-_/.#:]/.test(t[at - 1]);
    score += 1 + (startsWord ? 6 : 0) + (at === previous + 1 ? 5 : 0) - Math.min(at, 20) * 0.05;
    previous = at;
    from = at + 1;
  }
  // A shorter text that matches is a closer match than a long one.
  return score - t.length * 0.01;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** The items that match, best first; with no query, all of them in their given order. */
export function fuzzyRank<T>(query: string, items: readonly T[], text: (item: T) => string): Ranked<T>[] {
  if (!query.trim()) return items.map((item) => ({ item, score: 0 }));
  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    const score = fuzzyScore(query, text(item));
    if (score !== null) ranked.push({ item, score });
  }
  // Stable for equal scores, so the given order breaks ties.
  return ranked.map((r, index) => ({ r, index })).sort((a, b) => b.r.score - a.r.score || a.index - b.index).map(({ r }) => r);
}
