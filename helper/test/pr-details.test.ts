import { describe, expect, it } from 'vitest';
import { parsePrDetails } from '../src/pr-details';

const GH = {
  number: 3005,
  title: '[PROJ-1731] PROJ-1737 - Sync cache',
  url: 'https://github.com/acme/app/pull/3005',
  author: { login: 'bstanley-pec', name: 'Brian Stanley', is_bot: false },
  headRefName: 'feat/PROJ-1737/sync',
  baseRefName: 'develop',
  isDraft: false,
  additions: 2276,
  deletions: 15,
  changedFiles: 23,
  reviewDecision: 'CHANGES_REQUESTED',
  mergeable: 'MERGEABLE',
  createdAt: '2026-10-07T21:22:47Z',
  updatedAt: '2026-10-07T22:13:32Z',
  latestReviews: [
    { author: { login: 'JB-PEC' }, state: 'APPROVED', submittedAt: '2026-10-07T22:13:31Z', body: 'lgtm' },
    { author: { login: 'drew' }, state: 'CHANGES_REQUESTED', submittedAt: '2026-10-07T22:20:00Z', body: 'fix' },
  ],
  reviewRequests: [{ __typename: 'User', login: 'PrecisionWeaver' }, { __typename: 'Team', name: 'Platform', slug: 'platform' }],
  statusCheckRollup: [
    { __typename: 'CheckRun', name: 'ESLint', status: 'COMPLETED', conclusion: 'SUCCESS' },
    { __typename: 'CheckRun', name: 'Skipped', status: 'COMPLETED', conclusion: 'SKIPPED' },
    { __typename: 'CheckRun', name: 'Pest (3)', status: 'COMPLETED', conclusion: 'FAILURE' },
    { __typename: 'CheckRun', name: 'Vitest', status: 'IN_PROGRESS', conclusion: '' },
    { __typename: 'StatusContext', context: 'deploy/preview', state: 'PENDING' },
    { __typename: 'StatusContext', context: 'codecov', state: 'ERROR' },
  ],
};

describe('parsePrDetails', () => {
  it('summarizes the PR, its reviews, pending requests, and checks', () => {
    expect(parsePrDetails(JSON.stringify(GH))).toEqual({
      url: GH.url,
      title: GH.title,
      author: 'bstanley-pec',
      head: 'feat/PROJ-1737/sync',
      base: 'develop',
      isDraft: false,
      additions: 2276,
      deletions: 15,
      changedFiles: 23,
      reviewDecision: 'CHANGES_REQUESTED',
      mergeable: 'MERGEABLE',
      createdAt: '2026-10-07T21:22:47Z',
      updatedAt: '2026-10-07T22:13:32Z',
      reviews: [
        { login: 'JB-PEC', state: 'APPROVED', at: '2026-10-07T22:13:31Z' },
        { login: 'drew', state: 'CHANGES_REQUESTED', at: '2026-10-07T22:20:00Z' },
      ],
      requested: ['PrecisionWeaver', 'Platform'],
      checks: { passed: 2, failed: 2, pending: 2, failing: ['Pest (3)', 'codecov'] },
    });
  });

  it('treats missing optional fields as empty', () => {
    const minimal = { ...GH, reviewDecision: '', latestReviews: null, reviewRequests: null, statusCheckRollup: null };
    expect(parsePrDetails(JSON.stringify(minimal))).toMatchObject({
      reviewDecision: null,
      reviews: [],
      requested: [],
      checks: { passed: 0, failed: 0, pending: 0, failing: [] },
    });
  });

  it('rejects output that is not a PR', () => {
    expect(() => parsePrDetails('[]')).toThrow();
  });
});
