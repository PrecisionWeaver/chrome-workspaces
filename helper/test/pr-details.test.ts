import { describe, expect, it } from 'vitest';
import { parseBranchChecks, parsePrDetails, parsePrThreads, parsePrUrl, summarizeChecks } from '../src/pr-details';

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
      body: GH.body,
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

  it('keeps the description as written, capped, and caps files and commits', () => {
    const long = { ...GH, body: 'word '.repeat(2000), files: Array.from({ length: 30 }, (_, i) => ({ path: `f${i}`, additions: i, deletions: 0 })), commits: Array.from({ length: 12 }, (_, i) => ({ oid: `${i}`.padStart(7, '0'), messageHeadline: `c${i}`, committedDate: '2026-10-07T00:00:00Z', authors: [] })) };
    const details = parsePrDetails(JSON.stringify(long));
    expect(details.body).toHaveLength(6000);
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
      body: '',
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

describe('branch checks', () => {
  it('summarizes a branch\'s pull request and its checks', () => {
    const json = JSON.stringify({ number: 12, title: 'Fix it', url: 'https://github.com/acme/web-app/pull/12', isDraft: true, reviewDecision: '', statusCheckRollup: GH.statusCheckRollup });
    expect(parseBranchChecks(json)).toEqual({
      pr: { number: 12, title: 'Fix it', url: 'https://github.com/acme/web-app/pull/12', isDraft: true, reviewDecision: null },
      checks: { passed: 2, failed: 2, pending: 2, failing: ['Pest (3)', 'codecov'] },
    });
  });

  it('has nothing for output that is not a pull request, and counts nothing for no checks', () => {
    expect(parseBranchChecks('not json')).toBeNull();
    expect(parseBranchChecks('{"message":"nope"}')).toBeNull();
    expect(summarizeChecks(null)).toEqual({ passed: 0, failed: 0, pending: 0, failing: [] });
  });
});

describe('review threads', () => {
  const answer = (nodes: unknown[], totalCount = nodes.length) => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount, nodes } } } } });
  const comment = (login: string | null, body: string) => ({ author: login ? { login } : null, body, createdAt: '2026-10-08T10:00:00Z', url: `https://github.com/acme/web-app/pull/1#discussion_r${body.length}` });

  it('reads each thread with its comments, open threads first, and the line it is on', () => {
    const { threads, total } = parsePrThreads(
      answer([
        { isResolved: true, isOutdated: false, path: 'a.ts', line: 3, comments: { nodes: [comment('drew', 'done')] } },
        { isResolved: false, isOutdated: true, path: 'b.ts', line: null, originalLine: 9, comments: { nodes: [comment('drew', 'Please rename'), comment(null, 'ok')] } },
        { isResolved: false, isOutdated: false, path: 'c.ts', line: null, originalLine: null, comments: { nodes: [] } },
      ]),
    );
    expect(total).toBe(3);
    expect(threads.map((t) => [t.path, t.resolved])).toEqual([['b.ts', false], ['c.ts', false], ['a.ts', true]]);
    expect(threads[0]).toMatchObject({ line: 9, outdated: true });
    expect(threads[0].comments.map((c) => c.author)).toEqual(['drew', 'ghost']);
    expect(threads[1].line).toBeNull();
  });

  it('reports a total larger than what was returned, and fails clearly for an error or a PR that is not there', () => {
    expect(parsePrThreads(answer([], 120))).toEqual({ threads: [], total: 120 });
    expect(() => parsePrThreads(JSON.stringify({ errors: [{ message: 'Could not resolve to a PullRequest' }], data: { repository: { pullRequest: null } } }))).toThrow('Could not resolve');
    expect(() => parsePrThreads('{}')).toThrow('unexpected');
  });

  it('splits a pull request URL into the parts that go to gh, and rejects anything else', () => {
    expect(parsePrUrl('https://github.com/acme/web-app/pull/482')).toEqual({ owner: 'acme', repo: 'web-app', number: '482' });
    expect(parsePrUrl('https://github.com/acme/web-app/pull/482/')).not.toBeNull();
    for (const bad of ['https://evil.example/acme/web-app/pull/1', 'https://github.com/acme/web-app/pull/1; rm -rf ~', 'https://github.com/a b/c/pull/1', 'https://github.com/acme/web-app/issues/1']) expect(parsePrUrl(bad)).toBeNull();
  });
});
