import { describe, expect, it } from 'vitest';
import { GH, URL1, answer, lookup, pr, review } from '../../testing/reviews';
import { parseMergeStatuses, parseReviewRequests, ticketFromTitle } from './review-parse';

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
        branch: '',
        merge: 'draft',
        mergeReason: null,
        myReview: 'none',
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
        branch: '',
        merge: 'unknown',
        mergeReason: null,
        myReview: 'none',
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

describe('merge states', () => {
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
});

describe('your review', () => {
  const reviews = (...nodes: ReturnType<typeof review>[]) => ({ latestReviews: { nodes } });
  const requested = (...logins: (string | null)[]) => ({
    reviewRequests: { nodes: logins.map((login) => ({ requestedReviewer: login === null ? { name: 'core-team' } : { login } })) },
  });
  const mine = (extra: Record<string, unknown>, viewer: string | null = 'me') => parseMergeStatuses(answer(viewer, lookup(URL1, extra))).get(URL1)?.myReview;

  it('reads the head branch from the lookup', () => {
    expect(parseMergeStatuses(answer('me', lookup(URL1, { headRefName: 'proj-9/rework-sync' }))).get(URL1)?.branch).toBe('proj-9/rework-sync');
    expect(parseMergeStatuses(answer('me', lookup(URL1))).get(URL1)?.branch).toBe('');
  });

  it('is none without a review of yours, an unknown viewer, or only a pending draft', () => {
    expect(mine({})).toBe('none');
    expect(mine(reviews(review('them', 'APPROVED', 'new')))).toBe('none');
    expect(mine(reviews(review('me', 'APPROVED', 'new')), null)).toBe('none');
    expect(mine(reviews(review('me', 'PENDING', 'new')))).toBe('none');
    expect(mine({ ...reviews(review('me', 'PENDING', 'old')), ...requested('me') })).toBe('none');
  });

  it('says how you reviewed when nothing has changed since, whatever the case of your login', () => {
    expect(mine(reviews(review('me', 'APPROVED', 'new')))).toBe('approved');
    expect(mine(reviews(review('ME', 'COMMENTED', 'new')), 'me')).toBe('commented');
    expect(mine(reviews(review('me', 'CHANGES_REQUESTED', 'new')))).toBe('changes-requested');
  });

  it('keeps an approval as approved after a push, since a push does not undo it', () => {
    expect(mine(reviews(review('me', 'APPROVED', 'old')))).toBe('approved');
  });

  it('is new-commits when you commented and the head has moved on', () => {
    expect(mine(reviews(review('me', 'COMMENTED', 'old')))).toBe('new-commits');
  });

  it('is rereview when your requested changes were pushed on, your review was dismissed, or you were asked again', () => {
    expect(mine(reviews(review('me', 'CHANGES_REQUESTED', 'old')))).toBe('rereview');
    expect(mine(reviews(review('me', 'DISMISSED', 'new')))).toBe('rereview');
    expect(mine({ ...reviews(review('me', 'APPROVED', 'new')), ...requested('them', 'ME') })).toBe('rereview');
    expect(mine({ ...reviews(review('me', 'COMMENTED', 'old')), ...requested('me') })).toBe('rereview');
  });

  it('does not read a request through a team, or one before you ever reviewed, as being asked again', () => {
    expect(mine({ ...reviews(review('me', 'APPROVED', 'new')), ...requested(null) })).toBe('approved');
    expect(mine(requested('me'))).toBe('none');
  });

  it('does not read a missing commit as a push', () => {
    expect(mine(reviews(review('me', 'COMMENTED', null)))).toBe('commented');
    expect(mine({ ...reviews(review('me', 'CHANGES_REQUESTED', '')), headRefOid: '' })).toBe('changes-requested');
    expect(mine({ ...reviews(review('me', 'COMMENTED', 'old')), headRefOid: undefined })).toBe('commented');
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
});
