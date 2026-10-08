import { describe, expect, it } from 'vitest';
import { ghWatchedPrs, mergeStatusQuery, parseMergeStatuses, parseReviewRequests, ReviewsPoller, ticketFromTitle } from '../src/reviews';

const pr = (number: number, title: string, updatedAt: string) => ({
  author: { login: 'drew', is_bot: false },
  isDraft: number === 2,
  number,
  repository: { name: 'web-app', nameWithOwner: 'acme/web-app' },
  title,
  updatedAt,
  url: `https://github.com/acme/web-app/pull/${number}`,
});
const GH = JSON.stringify([pr(1, 'PROJ-10 - Fix it', '2026-10-01T00:00:00Z'), pr(2, 'Tidy up', '2026-10-02T00:00:00Z')]);

describe('ticketFromTitle', () => {
  it('prefers a key outside brackets, since a bracketed key names the parent', () => {
    expect(ticketFromTitle('[PROJ-1731] PROJ-1737 - Sync cache')).toBe('PROJ-1737');
    expect(ticketFromTitle('[PROJ-1731] Sync cache')).toBe('PROJ-1731');
    expect(ticketFromTitle('OPS-88: fix')).toBe('OPS-88');
    expect(ticketFromTitle('Bump deps')).toBeNull();
  });
});

describe('parseReviewRequests', () => {
  it('maps gh search output, most recently updated first', () => {
    expect(parseReviewRequests([GH])).toEqual([
      { repo: 'acme/web-app', number: 2, title: 'Tidy up', url: 'https://github.com/acme/web-app/pull/2', author: 'drew', isDraft: true, updatedAt: '2026-10-02T00:00:00Z', ticket: null, merge: 'draft', mergeReason: null },
      { repo: 'acme/web-app', number: 1, title: 'PROJ-10 - Fix it', url: 'https://github.com/acme/web-app/pull/1', author: 'drew', isDraft: false, updatedAt: '2026-10-01T00:00:00Z', ticket: 'PROJ-10', merge: 'unknown', mergeReason: null },
    ]);
  });

  it('merges several searches, listing a PR found by both once', () => {
    const other = JSON.stringify([pr(3, 'Tidy change', '2026-10-03T00:00:00Z'), pr(1, 'PROJ-10 - Fix it', '2026-10-01T00:00:00Z')]);
    expect(parseReviewRequests([GH, other]).map((r) => r.number)).toEqual([3, 2, 1]);
  });

  it('rejects output that is not a list', () => {
    expect(() => parseReviewRequests(['{"message":"Bad credentials"}'])).toThrow();
  });
});

describe('ReviewsPoller', () => {
  it('starts empty, then holds the fetched list and notifies', async () => {
    const poller = new ReviewsPoller(async () => [GH]);
    let changes = 0;
    poller.onChange(() => changes++);
    expect(poller.state()).toEqual({ items: [], error: null, fetchedAt: null });
    await poller.refresh();
    expect(poller.state().items.map((r) => r.number)).toEqual([2, 1]);
    expect(poller.state().error).toBeNull();
    expect(poller.state().fetchedAt).not.toBeNull();
    expect(changes).toBe(1);
  });

  it('keeps the last good list and reports the error when a fetch fails', async () => {
    let fail = false;
    const poller = new ReviewsPoller(async () => {
      if (fail) throw new Error('gh: authentication required');
      return [GH];
    });
    await poller.refresh();
    fail = true;
    await poller.refresh();
    expect(poller.state().items).toHaveLength(2);
    expect(poller.state().error).toBe('gh: authentication required');
  });

  it('reports unparseable output as an error', async () => {
    const poller = new ReviewsPoller(async () => ['not json']);
    await poller.refresh();
    expect(poller.state().error).toMatch(/JSON/);
  });

  it('shares a fetch already in flight', async () => {
    let calls = 0;
    const poller = new ReviewsPoller(async () => {
      calls++;
      return [GH];
    });
    await Promise.all([poller.refresh(), poller.refresh()]);
    expect(calls).toBe(1);
  });
});

const URL1 = 'https://github.com/acme/web-app/pull/1';
const URL2 = 'https://github.com/acme/web-app/pull/2';
const merge = (url: string, mergeStateStatus: string) => ({ pullRequest: { url, mergeStateStatus, reviewDecision: null } });

describe('merge states', () => {
  it('asks for every PR in one query, skipping a repo name that is not plain', () => {
    const [two, one] = parseReviewRequests([GH]);
    const query = mergeStatusQuery([two, one, { ...one, repo: 'x/y" } } mutation { z' }]);
    expect(query).toContain('r0: repository(owner: "acme", name: "web-app") { pullRequest(number: 2)');
    expect(query).toContain('r1: repository(owner: "acme", name: "web-app") { pullRequest(number: 1)');
    expect(query).not.toContain('mutation');
  });

  it('maps GitHub merge states to ready, review, draft, blocked with a reason, or unknown', () => {
    const at = (mergeStateStatus: string, reviewDecision: string | null = null) => ({ pullRequest: { url: mergeStateStatus + reviewDecision, mergeStateStatus, reviewDecision } });
    const json = JSON.stringify({
      data: {
        clean: at('CLEAN', 'APPROVED'),
        unprotected: at('CLEAN'),
        needsReview: at('BLOCKED', 'REVIEW_REQUIRED'),
        changes: at('BLOCKED', 'CHANGES_REQUESTED'),
        blocked: at('BLOCKED', 'APPROVED'),
        conflicts: at('DIRTY', 'REVIEW_REQUIRED'),
        behind: at('BEHIND'),
        checks: at('UNSTABLE'),
        draft: at('DRAFT', 'REVIEW_REQUIRED'),
        unknown: at('UNKNOWN'),
        missing: null,
        none: { pullRequest: null },
      },
    });
    expect([...parseMergeStatuses(json)].map(([, state]) => [state.merge, state.mergeReason])).toEqual([
      ['ready', null],
      ['ready', null],
      ['review', null],
      ['blocked', 'Changes requested'],
      ['blocked', 'Blocked'],
      ['blocked', 'Conflicts'],
      ['blocked', 'Behind'],
      ['blocked', 'Checks failing'],
      ['draft', null],
      ['unknown', null],
    ]);
  });

  it('puts merge states on the polled list, leaving a PR the response omits unknown', async () => {
    const poller = new ReviewsPoller(async () => [GH], async () => JSON.stringify({ data: { a: merge(URL1, 'CLEAN') } }));
    await poller.refresh();
    expect(poller.state().items.map((r) => [r.number, r.merge])).toEqual([[2, 'draft'], [1, 'ready']]);
  });

  it('keeps a draft a draft whatever GitHub reports for it', async () => {
    const poller = new ReviewsPoller(async () => [GH], async () => JSON.stringify({ data: { a: merge(URL2, 'CLEAN') } }));
    await poller.refresh();
    expect(poller.state().items.find((r) => r.number === 2)?.merge).toBe('draft');
  });

  it('keeps the list, with unknown states, when the merge lookup fails', async () => {
    const poller = new ReviewsPoller(async () => [GH], async () => {
      throw new Error('graphql down');
    });
    await poller.refresh();
    expect(poller.state().error).toBeNull();
    expect(poller.state().items.map((r) => r.merge)).toEqual(['draft', 'unknown']);
  });
});

describe('ghWatchedPrs', () => {
  it('searches every watched repo and does not exclude the user\'s own PRs', () => {
    const command = ghWatchedPrs(['acme/api', 'acme/web-app']);
    expect(command).toContain('--repo acme/api --repo acme/web-app');
    expect(command).not.toContain('author');
  });
});
