import { describe, expect, it } from 'vitest';
import { GH } from '../../testing/reviews';
import { parseReviewRequests } from './review-parse';
import { ghOwnPrs, ghReviewedPrs, ghWatchedPrs, mergeStatusQuery } from './review-queries';

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

describe('ghReviewedPrs', () => {
  it('searches for your reviews in every repo', () => {
    expect(ghReviewedPrs).toContain('gh search prs --state=open --reviewed-by=@me');
    expect(ghReviewedPrs).not.toContain('--repo');
  });
});

describe('mergeStatusQuery', () => {
  it('asks for every PR in one query, skipping a repo name that is not plain', () => {
    const [two, one] = parseReviewRequests([GH]);
    const query = mergeStatusQuery([two, one, { ...one, repo: 'x/y" } } mutation { z' }]);
    expect(query).toContain('r0: repository(owner: "acme", name: "web-app") { pullRequest(number: 2)');
    expect(query).toContain('r1: repository(owner: "acme", name: "web-app") { pullRequest(number: 1)');
    expect(query).not.toContain('mutation');
  });

  it('asks for the viewer, the reviewed commit, who is asked to review and the rolled-up checks, not each check run', () => {
    const query = mergeStatusQuery(parseReviewRequests([GH]));
    expect(query).toContain('viewer { login }');
    expect(query).toContain('headRefOid');
    expect(query).toContain('headRefName');
    expect(query).toContain('latestReviews(first: 100) { nodes { author { login } state commit { oid } } }');
    expect(query).toContain('statusCheckRollup { state }');
    expect(query).toContain('reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } } } }');
    expect(query).not.toContain('contexts');
  });
});
