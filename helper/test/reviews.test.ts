import { describe, expect, it, vi } from 'vitest';
import {
  describeFailure,
  ghOwnPrs,
  ghReviewedPrs,
  ghWatchedPrs,
  isRateLimited,
  isTransient,
  MERGE_BATCH,
  MERGE_CONCURRENCY,
  mergeStatusQuery,
  parseMergeStatuses,
  parseReviewRequests,
  ReviewsPoller,
  ticketFromTitle,
} from '../src/reviews';

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
      {
        repo: 'acme/web-app',
        number: 2,
        title: 'Tidy up',
        url: 'https://github.com/acme/web-app/pull/2',
        author: 'drew',
        isDraft: true,
        updatedAt: '2026-10-02T00:00:00Z',
        ticket: null,
        merge: 'draft',
        mergeReason: null,
        needsReReview: false,
        approved: false,
        ci: null,
      },
      {
        repo: 'acme/web-app',
        number: 1,
        title: 'PROJ-10 - Fix it',
        url: 'https://github.com/acme/web-app/pull/1',
        author: 'drew',
        isDraft: false,
        updatedAt: '2026-10-01T00:00:00Z',
        ticket: 'PROJ-10',
        merge: 'unknown',
        mergeReason: null,
        needsReReview: false,
        approved: false,
        ci: null,
      },
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
    expect(poller.state()).toEqual({ items: [], error: null, fetchedAt: null, refreshing: false });
    await poller.refresh();
    expect(poller.state().items.map((r) => r.number)).toEqual([2, 1]);
    expect(poller.state().error).toBeNull();
    expect(poller.state().fetchedAt).not.toBeNull();
    // Once when the fetch starts, once when it ends.
    expect(changes).toBe(2);
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

  it('reports refreshing from the moment a fetch starts until it ends, notifying at both', async () => {
    const poller = new ReviewsPoller(async () => [GH]);
    const seen: boolean[] = [];
    poller.onChange(() => seen.push(poller.state().refreshing));
    const done = poller.refresh();
    expect(poller.state().refreshing).toBe(true);
    await done;
    expect(poller.state().refreshing).toBe(false);
    expect(seen).toEqual([true, false]);
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
    const at = (mergeStateStatus: string, reviewDecision: string | null = null) => ({
      pullRequest: { url: mergeStateStatus + reviewDecision, mergeStateStatus, reviewDecision },
    });
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
    const poller = new ReviewsPoller(
      async () => [GH],
      async () => JSON.stringify({ data: { a: merge(URL1, 'CLEAN') } }),
    );
    await poller.refresh();
    expect(poller.state().items.map((r) => [r.number, r.merge])).toEqual([
      [2, 'draft'],
      [1, 'ready'],
    ]);
  });

  it('keeps a draft a draft whatever GitHub reports for it', async () => {
    const poller = new ReviewsPoller(
      async () => [GH],
      async () => JSON.stringify({ data: { a: merge(URL2, 'CLEAN') } }),
    );
    await poller.refresh();
    expect(poller.state().items.find((r) => r.number === 2)?.merge).toBe('draft');
  });

  it('keeps the list, with unknown states, when the merge lookup fails', async () => {
    const poller = new ReviewsPoller(
      async () => [GH],
      async () => {
        throw new Error('graphql down');
      },
      0,
    );
    await poller.refresh();
    expect(poller.state().error).toBeNull();
    expect(poller.state().items.map((r) => r.merge)).toEqual(['draft', 'unknown']);
  });
});

describe('ghWatchedPrs', () => {
  it("searches every watched repo and does not exclude the user's own PRs", () => {
    const command = ghWatchedPrs(['acme/api', 'acme/web-app']);
    expect(command).toContain('--repo acme/api --repo acme/web-app');
    expect(command).not.toContain('-author');
    expect(command).not.toContain('@me');
  });
});

describe('ghOwnPrs', () => {
  it("searches the user's own open PRs in each repo", () => {
    expect(ghOwnPrs(['acme/api', 'acme/web-app'])).toContain('--repo acme/api --repo acme/web-app --state=open --author=@me');
  });
});

describe('merge state batches', () => {
  const many = (count: number) =>
    JSON.stringify(
      Array.from({ length: count }, (_, i) => ({
        number: i + 1,
        title: `PR ${i + 1}`,
        url: `https://github.com/acme/app/pull/${i + 1}`,
        repository: { nameWithOwner: 'acme/app' },
        author: { login: 'octo' },
        isDraft: false,
        updatedAt: `2026-01-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
      })),
    );
  const answer = (query: string, state = 'CLEAN') =>
    JSON.stringify({
      data: Object.fromEntries(
        [...query.matchAll(/r(\d+): .*?pullRequest\(number: (\d+)\)/g)].map(([, key, number]) => [
          `r${key}`,
          merge(`https://github.com/acme/app/pull/${number}`, state),
        ]),
      ),
    });

  it('asks in batches of no more than MERGE_BATCH, so no one query is large', async () => {
    const sizes: number[] = [];
    const poller = new ReviewsPoller(
      async () => [many(MERGE_BATCH * 2 + 3)],
      async (query) => {
        sizes.push((query.match(/pullRequest\(/g) ?? []).length);
        return answer(query);
      },
    );
    await poller.refresh();
    expect(sizes.sort((a, b) => a - b)).toEqual([3, MERGE_BATCH, MERGE_BATCH]);
    expect(poller.state().items.every((item) => item.merge === 'ready')).toBe(true);
  });

  it('retries a batch that failed as two halves, and uses their answers', async () => {
    const sizes: number[] = [];
    const poller = new ReviewsPoller(
      async () => [many(3)],
      async (query) => {
        sizes.push((query.match(/pullRequest\(/g) ?? []).length);
        if (sizes.length === 1) throw Object.assign(new Error('Command failed'), { stderr: 'gh: HTTP 504' });
        return answer(query);
      },
      0,
    );
    await poller.refresh();
    expect(sizes).toEqual([3, 2, 1]);
    expect(poller.state().items.map((item) => item.merge)).toEqual(['ready', 'ready', 'ready']);
  });

  it('retries a batch of one PR as itself', async () => {
    let calls = 0;
    const poller = new ReviewsPoller(
      async () => [many(1)],
      async (query) => {
        if (calls++ === 0) throw Object.assign(new Error('x'), { killed: true });
        return answer(query);
      },
      0,
    );
    await poller.refresh();
    expect(calls).toBe(2);
    expect(poller.state().items[0].merge).toBe('ready');
  });

  it('loses only the half that fails again, and says how many', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poller = new ReviewsPoller(
      async () => [many(4)],
      async (query) => {
        // The whole batch, then the half holding PR 1, time out.
        if (query.includes('pullRequest(number: 1)')) throw Object.assign(new Error('x'), { killed: true });
        return answer(query);
      },
      0,
    );
    await poller.refresh();
    const byNumber = new Map(poller.state().items.map((item) => [item.number, item.merge]));
    expect([1, 2, 3, 4].map((n) => byNumber.get(n))).toEqual(['unknown', 'unknown', 'ready', 'ready']);
    expect(warn).toHaveBeenCalledWith('could not read merge states for 2 of 4 PRs: timed out');
    warn.mockRestore();
  });

  it(`asks no more than ${MERGE_CONCURRENCY} batches at once`, async () => {
    let inFlight = 0;
    let most = 0;
    const poller = new ReviewsPoller(
      async () => [many(MERGE_BATCH * 5)],
      async (query) => {
        most = Math.max(most, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return answer(query);
      },
    );
    await poller.refresh();
    expect(most).toBe(MERGE_CONCURRENCY);
    expect(poller.state().items.every((item) => item.merge === 'ready')).toBe(true);
  });

  it('asks no further batches once GitHub rate-limits one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    const poller = new ReviewsPoller(
      async () => [many(MERGE_BATCH * 5)],
      async () => {
        calls++;
        throw Object.assign(new Error('x'), { stderr: 'gh: API rate limit exceeded' });
      },
      0,
    );
    await poller.refresh();
    expect(calls).toBe(MERGE_CONCURRENCY);
    expect(poller.state().error).toMatch(/rate-limiting/);
    warn.mockRestore();
  });

  it('loses only the failed batch, and keeps those PRs' + "'" + ' last known state', async () => {
    const fail = { value: false };
    const poller = new ReviewsPoller(
      async () => [many(MERGE_BATCH + 2)],
      async (query) => {
        // The second batch is the one holding PR 26 and up.
        if (fail.value && query.includes(`pullRequest(number: ${MERGE_BATCH + 1})`)) throw Object.assign(new Error('x'), { killed: true });
        return answer(query, fail.value ? 'BEHIND' : 'CLEAN');
      },
      0,
    );
    await poller.refresh();
    fail.value = true;
    await poller.refresh();
    const byNumber = new Map(poller.state().items.map((item) => [item.number, item]));
    expect(byNumber.get(1)).toMatchObject({ merge: 'blocked', mergeReason: 'Behind' });
    expect(byNumber.get(MERGE_BATCH + 1)).toMatchObject({ merge: 'ready', mergeReason: null });
    expect(byNumber.get(MERGE_BATCH + 2)).toMatchObject({ merge: 'ready' });
  });

  it('logs one line saying how much was lost and why, not a stack trace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const poller = new ReviewsPoller(
      async () => [many(MERGE_BATCH + 1)],
      async () => {
        throw Object.assign(new Error('Command failed'), { killed: true });
      },
      0,
    );
    await poller.refresh();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(`could not read merge states for ${MERGE_BATCH + 1} of ${MERGE_BATCH + 1} PRs: timed out`);
    warn.mockRestore();
  });
});

describe('a merge state GitHub has not computed yet', () => {
  it('keeps the last known badge when GitHub answers UNKNOWN, and shows unknown when there was none', async () => {
    const state = { value: 'CLEAN' };
    const poller = new ReviewsPoller(
      async () => [GH],
      async () => JSON.stringify({ data: { a: merge(URL1, state.value) } }),
      0,
    );
    state.value = 'UNKNOWN';
    await poller.refresh();
    expect(poller.state().items.find((r) => r.number === 1)?.merge).toBe('unknown');
    state.value = 'CLEAN';
    await poller.refresh();
    state.value = 'UNKNOWN';
    await poller.refresh();
    expect(poller.state().items.find((r) => r.number === 1)?.merge).toBe('ready');
  });
});

describe('describeFailure', () => {
  it("names a timeout, gh's own message, a non-JSON page, or the error text", () => {
    expect(describeFailure(Object.assign(new Error('Command failed: gh\n'), { killed: true, signal: 'SIGTERM' }))).toBe('timed out');
    expect(describeFailure(Object.assign(new Error('Command failed: gh'), { stderr: 'gh: HTTP 504\nmore' }))).toBe('gh: HTTP 504');
    expect(describeFailure(new SyntaxError('Unexpected token <'))).toBe('GitHub sent a page that was not JSON');
    expect(describeFailure(new Error('boom\nstack'))).toBe('boom');
  });
});

const lookup = (url: string, extra: Record<string, unknown> = {}) => ({
  pullRequest: { url, mergeStateStatus: 'CLEAN', reviewDecision: null, headRefOid: 'new', ...extra },
});
const review = (login: string, state: string, oid: string | null) => ({ author: { login }, state, commit: oid === null ? null : { oid } });
const answer = (viewer: string | null, ...lookups: ReturnType<typeof lookup>[]) =>
  JSON.stringify({ data: { ...(viewer ? { viewer: { login: viewer } } : {}), ...Object.fromEntries(lookups.map((l, i) => [`r${i}`, l])) } });

describe('a PR you approved', () => {
  const approved = (extra: Record<string, unknown>, viewer: string | null = 'me') =>
    parseMergeStatuses(answer(viewer, lookup(URL1, extra))).get(URL1)?.approved;
  const reviews = (...nodes: ReturnType<typeof review>[]) => ({ latestReviews: { nodes } });

  it('is true when your latest review is an approval, whatever the case of your login', () => {
    expect(approved(reviews(review('me', 'APPROVED', 'old')))).toBe(true);
    expect(approved(reviews(review('ME', 'APPROVED', 'new')), 'me')).toBe(true);
  });

  it("is false for another reviewer's approval, your other reviews, or an unknown viewer", () => {
    expect(approved(reviews(review('them', 'APPROVED', 'new')))).toBe(false);
    expect(approved(reviews(review('me', 'CHANGES_REQUESTED', 'new')))).toBe(false);
    expect(approved(reviews(review('me', 'APPROVED', 'new')), null)).toBe(false);
    expect(approved({})).toBe(false);
  });
});

describe('a PR that needs another look', () => {
  const reviews = (...nodes: ReturnType<typeof review>[]) => ({ latestReviews: { nodes } });
  const needs = (extra: Record<string, unknown>, viewer: string | null = 'me') =>
    parseMergeStatuses(answer(viewer, lookup(URL1, extra))).get(URL1)?.needsReReview;

  it('asks for the viewer, the reviewed commit and the rolled-up checks, not each check run', () => {
    const query = mergeStatusQuery(parseReviewRequests([GH]));
    expect(query).toContain('viewer { login }');
    expect(query).toContain('headRefOid');
    expect(query).toContain('latestReviews(first: 100) { nodes { author { login } state commit { oid } } }');
    expect(query).toContain('statusCheckRollup { state }');
    expect(query).not.toContain('contexts');
  });

  it('is true when your changes-requested or comment review is on an older commit than the head', () => {
    expect(needs(reviews(review('me', 'CHANGES_REQUESTED', 'old')))).toBe(true);
    expect(needs(reviews(review('me', 'COMMENTED', 'old')))).toBe(true);
    expect(needs(reviews(review('ME', 'COMMENTED', 'old')), 'me')).toBe(true);
  });

  it('is false for an approval, a review of the current head, or someone else’s review', () => {
    expect(needs(reviews(review('me', 'APPROVED', 'old')))).toBe(false);
    expect(needs(reviews(review('me', 'CHANGES_REQUESTED', 'new')))).toBe(false);
    expect(needs(reviews(review('you', 'CHANGES_REQUESTED', 'old')))).toBe(false);
    expect(needs(reviews(review('me', 'DISMISSED', 'old')))).toBe(false);
  });

  it('is false when either commit is missing, rather than reading a gap as a push', () => {
    expect(needs(reviews(review('me', 'COMMENTED', null)))).toBe(false);
    expect(needs({ ...reviews(review('me', 'COMMENTED', '')), headRefOid: '' })).toBe(false);
    expect(needs({ ...reviews(review('me', 'COMMENTED', 'old')), headRefOid: undefined })).toBe(false);
    expect(needs(reviews(review('me', 'COMMENTED', 'old')), null)).toBe(false);
  });

  it('lists a PR you reviewed only when it needs re-review, and flags one already on the list', async () => {
    const requested = JSON.stringify([pr(1, 'Requested', '2026-10-03T00:00:00Z')]);
    const reviewed = JSON.stringify([
      pr(1, 'Requested', '2026-10-03T00:00:00Z'),
      pr(2, 'Pushed since', '2026-10-02T00:00:00Z'),
      pr(3, 'Unchanged', '2026-10-01T00:00:00Z'),
    ]);
    const poller = new ReviewsPoller(
      async () => [requested],
      async () =>
        answer(
          'me',
          lookup(URL1, reviews(review('me', 'COMMENTED', 'old'))),
          lookup(URL2, reviews(review('me', 'CHANGES_REQUESTED', 'old'))),
          lookup('https://github.com/acme/web-app/pull/3', reviews(review('me', 'CHANGES_REQUESTED', 'new'))),
        ),
      0,
      { fetchReviewed: async () => [reviewed] },
    );
    await poller.refresh();
    expect(poller.state().items.map((r) => [r.number, r.needsReReview])).toEqual([
      [1, true],
      [2, true],
    ]);
  });

  it('leaves reviewed PRs out when the merge lookup cannot say whether they changed', async () => {
    const reviewed = JSON.stringify([pr(2, 'Pushed since', '2026-10-02T00:00:00Z')]);
    const poller = new ReviewsPoller(async () => [GH], undefined, 0, { fetchReviewed: async () => [reviewed] });
    await poller.refresh();
    expect(poller.state().items.map((r) => r.number)).toEqual([2, 1]);
    expect(poller.state().items.every((r) => !r.needsReReview)).toBe(true);
  });

  it('keeps the flag from the last good lookup when a later one fails', async () => {
    let fail = false;
    const poller = new ReviewsPoller(
      async () => [GH],
      async () => {
        if (fail) throw new Error('graphql down');
        return answer('me', lookup(URL1, { ...reviews(review('me', 'COMMENTED', 'old')) }));
      },
      0,
    );
    await poller.refresh();
    fail = true;
    await poller.refresh();
    expect(poller.state().items.find((r) => r.number === 1)?.needsReReview).toBe(true);
  });

  it('searches for your reviews in the given repos', () => {
    expect(ghReviewedPrs(['acme/api', 'acme/web-app'])).toContain('--repo acme/api --repo acme/web-app --state=open --reviewed-by=@me');
  });
});

describe('checks', () => {
  const ci = (state: string | null) => ({
    commits: { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] },
  });
  const read = (state: string | null) => parseMergeStatuses(answer('me', lookup(URL1, ci(state)))).get(URL1)?.ci;

  it('rolls GitHub’s state up to passing, failing or pending, and none without checks', () => {
    expect([read('SUCCESS'), read('FAILURE'), read('ERROR'), read('PENDING'), read('EXPECTED'), read(null)]).toEqual([
      'passing',
      'failing',
      'failing',
      'pending',
      'pending',
      null,
    ]);
  });

  it('reads a state it does not know as pending, never as passing', () => {
    expect(read('SOMETHING_NEW')).toBe('pending');
  });

  it('puts the checks on the polled list, also for a draft', async () => {
    const poller = new ReviewsPoller(
      async () => [GH],
      async () => answer('me', lookup(URL1, ci('FAILURE')), lookup(URL2, ci('SUCCESS'))),
      0,
    );
    await poller.refresh();
    expect(poller.state().items.map((r) => [r.number, r.ci])).toEqual([
      [2, 'passing'],
      [1, 'failing'],
    ]);
  });
});

describe('searches that fail on GitHub’s side', () => {
  const gateway = () => Object.assign(new Error('Command failed: gh search'), { stderr: 'HTTP 504: 504 Gateway Timeout\n' });

  it('tells a gateway error or a cut-off reply from one that will not get better', () => {
    expect(isTransient(gateway())).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { stderr: 'unexpected end of JSON input' }))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { stderr: 'Post "https://api.github.com/graphql": net/http: TLS handshake timeout' }))).toBe(true);
    expect(isTransient(Object.assign(new Error('x'), { stderr: 'HTTP 401: Bad credentials' }))).toBe(false);
    expect(isTransient(new Error('Command failed: gh search prs --repo acme/timeout-service'))).toBe(false);
  });

  it('tries a search again and uses the answer that follows', async () => {
    let calls = 0;
    const poller = new ReviewsPoller(
      async () => {
        if (calls++ < 2) throw gateway();
        return [GH];
      },
      undefined,
      0,
    );
    await poller.refresh();
    expect(calls).toBe(3);
    expect(poller.state().error).toBeNull();
    expect(poller.state().items).toHaveLength(2);
  });

  it('gives up after three tries and says why', async () => {
    let calls = 0;
    const poller = new ReviewsPoller(
      async () => {
        calls++;
        throw gateway();
      },
      undefined,
      0,
    );
    await poller.refresh();
    expect(calls).toBe(3);
    expect(poller.state().error).toMatch(/Command failed/);
  });

  it('does not try again when the failure is not transient', async () => {
    let calls = 0;
    const poller = new ReviewsPoller(
      async () => {
        calls++;
        throw Object.assign(new Error('Command failed'), { stderr: 'HTTP 401: Bad credentials' });
      },
      undefined,
      0,
    );
    await poller.refresh();
    expect(calls).toBe(1);
  });
});

describe('rate limits', () => {
  const limited = () => Object.assign(new Error('Command failed'), { stderr: 'gh: API rate limit exceeded for user' });

  it('recognises GitHub’s wording', () => {
    expect(isRateLimited(limited())).toBe(true);
    expect(isRateLimited(Object.assign(new Error('x'), { stderr: 'HTTP 429' }))).toBe(true);
    expect(isRateLimited(Object.assign(new Error('x'), { stderr: 'You have triggered an abuse detection mechanism' }))).toBe(true);
    expect(isRateLimited(gatewayError())).toBe(false);
  });
  function gatewayError() {
    return Object.assign(new Error('x'), { stderr: 'HTTP 504' });
  }

  it('pauses for a minute, then doubles the wait each time it is limited again, up to fifteen minutes', async () => {
    let now = 1_000_000;
    let calls = 0;
    const poller = new ReviewsPoller(
      async () => {
        calls++;
        throw limited();
      },
      undefined,
      0,
      { now: () => now },
    );
    const waits: number[] = [];
    for (let i = 0; i < 7; i++) {
      await poller.refresh();
      const before = calls;
      // Still paused one millisecond before the end: no request is made.
      const wait = [60, 120, 240, 480, 900, 900, 900][i]! * 1000;
      now += wait - 1;
      await poller.refresh();
      expect(calls).toBe(before);
      now += 1;
      waits.push(wait);
    }
    expect(calls).toBe(7);
    expect(poller.state().error).toMatch(/rate-limiting requests\. Trying again after /);
  });

  it('keeps the last good list while paused, and resumes, with the wait reset, once a fetch works', async () => {
    let now = 0;
    let mode: 'ok' | 'limited' = 'ok';
    const poller = new ReviewsPoller(
      async () => {
        if (mode === 'limited') throw limited();
        return [GH];
      },
      undefined,
      0,
      { now: () => now },
    );
    await poller.refresh();
    mode = 'limited';
    await poller.refresh();
    expect(poller.state().items).toHaveLength(2);
    expect(poller.state().error).toMatch(/rate-limiting/);
    now += 60_000;
    mode = 'ok';
    await poller.refresh();
    expect(poller.state().error).toBeNull();
    mode = 'limited';
    await poller.refresh();
    // The wait began again at a minute, not at two.
    now += 59_999;
    mode = 'ok';
    await poller.refresh();
    expect(poller.state().error).toMatch(/rate-limiting/);
    now += 1;
    await poller.refresh();
    expect(poller.state().error).toBeNull();
  });

  it('pauses too when only the merge lookup is limited, without retrying it, and still lists the PRs', async () => {
    let now = 0;
    let lookups = 0;
    const poller = new ReviewsPoller(
      async () => [GH],
      async () => {
        lookups++;
        throw limited();
      },
      0,
      { now: () => now },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await poller.refresh();
    expect(lookups).toBe(1);
    expect(poller.state().items).toHaveLength(2);
    expect(poller.state().error).toMatch(/rate-limiting/);
    await poller.refresh();
    expect(lookups).toBe(1);
    now += 60_000;
    await poller.refresh();
    expect(lookups).toBe(2);
    warn.mockRestore();
  });
});
