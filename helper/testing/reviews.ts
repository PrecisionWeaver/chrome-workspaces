// Fixtures shared by the review tests: a gh search result, and the answers of the merge-state lookup.
export const pr = (number: number, title: string, updatedAt: string) => ({
  author: { login: 'drew', is_bot: false },
  isDraft: number === 2,
  number,
  repository: { name: 'web-app', nameWithOwner: 'acme/web-app' },
  title,
  updatedAt,
  url: `https://github.com/acme/web-app/pull/${number}`,
});
export const GH = JSON.stringify([pr(1, 'PROJ-10 - Fix it', '2026-10-01T00:00:00Z'), pr(2, 'Tidy up', '2026-10-02T00:00:00Z')]);
export const URL1 = 'https://github.com/acme/web-app/pull/1';
export const lookup = (url: string, extra: Record<string, unknown> = {}) => ({
  pullRequest: { url, mergeStateStatus: 'CLEAN', reviewDecision: null, headRefOid: 'new', ...extra },
});
export const review = (login: string, state: string, oid: string | null) => ({ author: { login }, state, commit: oid === null ? null : { oid } });
export const answer = (viewer: string | null, ...lookups: ReturnType<typeof lookup>[]) =>
  JSON.stringify({ data: { ...(viewer ? { viewer: { login: viewer } } : {}), ...Object.fromEntries(lookups.map((l, i) => [`r${i}`, l])) } });
