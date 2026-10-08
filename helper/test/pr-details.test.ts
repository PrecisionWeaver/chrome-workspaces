import { describe, expect, it } from 'vitest';
import { parsePrDetails } from '../src/pr-details';

const GH = {
  number: 3005,
  title: '[PROJ-1731] PROJ-1737 - Sync cache',
  url: 'https://github.com/acme/web-app/pull/3005',
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
  body: '<!-- template -->\n## Summary\n- Adds the **sync cache** ([PROJ-1737](https://jira.example/PROJ-1737))\n![shot](https://x/y.png)\n\n## Testing\n- [x] ran the suite',
  labels: [{ name: 'backend' }, { name: 'needs-qa' }],
  comments: [{}, {}, {}],
  files: [
    { path: 'app/Small.php', additions: 1, deletions: 0 },
    { path: 'app/Big.php', additions: 400, deletions: 10 },
    { path: 'tests/Mid.php', additions: 50, deletions: 20 },
  ],
  commits: [
    { oid: 'aaaaaaa1111', messageHeadline: 'first', committedDate: '2026-10-07T21:00:00Z', authors: [{ login: 'bstanley-pec' }] },
    { oid: 'bbbbbbb2222', messageHeadline: 'second', committedDate: '2026-10-07T22:00:00Z', authors: [{ name: 'Brian Stanley' }] },
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
      summary: 'Adds the sync cache (PROJ-1737) ran the suite',
      labels: ['backend', 'needs-qa'],
      comments: 3,
      files: [
        { path: 'app/Big.php', additions: 400, deletions: 10 },
        { path: 'tests/Mid.php', additions: 50, deletions: 20 },
        { path: 'app/Small.php', additions: 1, deletions: 0 },
      ],
      commits: [
        { sha: 'bbbbbbb', headline: 'second', author: 'Brian Stanley', date: '2026-10-07T22:00:00Z' },
        { sha: 'aaaaaaa', headline: 'first', author: 'bstanley-pec', date: '2026-10-07T21:00:00Z' },
      ],
      commitCount: 2,
    });
  });

  it('cuts a long description at a word, and caps files and commits', () => {
    const long = { ...GH, body: 'word '.repeat(300), files: Array.from({ length: 30 }, (_, i) => ({ path: `f${i}`, additions: i, deletions: 0 })), commits: Array.from({ length: 12 }, (_, i) => ({ oid: `${i}`.padStart(7, '0'), messageHeadline: `c${i}`, committedDate: '2026-10-07T00:00:00Z', authors: [] })) };
    const details = parsePrDetails(JSON.stringify(long));
    expect(details.summary.length).toBeLessThanOrEqual(421);
    expect(details.summary.endsWith('word…')).toBe(true);
    expect(details.files).toHaveLength(10);
    expect(details.files[0].path).toBe('f29');
    expect(details.commits).toHaveLength(6);
    expect(details.commits[0].headline).toBe('c11');
    expect(details.commitCount).toBe(12);
    expect(details.commits[0].author).toBe('unknown');
  });

  it('treats missing optional fields as empty', () => {
    const minimal = { ...GH, reviewDecision: '', latestReviews: null, reviewRequests: null, statusCheckRollup: null, body: null, labels: null, comments: null, files: null, commits: null };
    expect(parsePrDetails(JSON.stringify(minimal))).toMatchObject({
      summary: '',
      labels: [],
      comments: 0,
      files: [],
      commits: [],
      commitCount: 0,
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
