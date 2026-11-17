import type { ReviewRequest } from '../../../shared/protocol/pull-requests';

const GH_FIELDS = '--json number,title,url,repository,author,isDraft,updatedAt';
export const GH_REVIEW_REQUESTS = `gh search prs --review-requested=@me --state=open ${GH_FIELDS} --limit 50`;

/** Every open PR in the watched repos, yours included, for repos where nobody requests reviewers. */
export function ghWatchedPrs(repos: readonly string[]): string {
  return `gh search prs ${repoFlags(repos)} --state=open ${GH_FIELDS} --limit 100`;
}

/** PRs you have already reviewed, which no longer match a review request; they are listed only if they need another look. */
export function ghReviewedPrs(repos: readonly string[]): string {
  return `gh search prs ${repoFlags(repos)} --state=open --reviewed-by=@me ${GH_FIELDS} --limit 50`;
}

const SAFE_NAME = /^[\w.-]+$/;

/** `--repo` for each repository, for the search commands that take a list of them. */
const repoFlags = (repos: readonly string[]): string => repos.map((repo) => `--repo ${repo}`).join(' ');

/** Your own open PRs in the given repos, which nobody has requested your review on. */
export function ghOwnPrs(repos: readonly string[]): string {
  return `gh search prs ${repoFlags(repos)} --state=open --author=@me ${GH_FIELDS} --limit 50`;
}

/**
 * One GraphQL request for what `gh search` does not report: every PR's merge state, the commit your latest review
 * was on, and the head commit's checks as one rolled-up state (the individual check runs are what makes a big query time out).
 */
export function mergeStatusQuery(items: readonly ReviewRequest[]): string {
  const lookups = items.flatMap((item, index) => {
    const [owner, name] = item.repo.split('/');
    if (!owner || !name || !SAFE_NAME.test(owner) || !SAFE_NAME.test(name)) return [];
    return [
      `r${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${item.number}) { url headRefName mergeStateStatus reviewDecision headRefOid ` +
        'latestReviews(first: 100) { nodes { author { login } state commit { oid } } } ' +
        'commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } }',
    ];
  });
  return `query { viewer { login } ${lookups.join(' ')} }`;
}
