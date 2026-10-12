import { describe, expect, it, vi } from 'vitest';
import {
  describeFailure,
  ghOwnPrs,
  ghWatchedPrs,
  MERGE_BATCH,
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

  it('retries a batch that failed once, and uses its answer', async () => {
    let calls = 0;
    const poller = new ReviewsPoller(
      async () => [many(3)],
      async (query) => {
        if (calls++ === 0) throw Object.assign(new Error('Command failed'), { stderr: 'gh: HTTP 504' });
        return answer(query);
      },
      0,
    );
    await poller.refresh();
    expect(calls).toBe(2);
    expect(poller.state().items.map((item) => item.merge)).toEqual(['ready', 'ready', 'ready']);
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
