import type { CiState, MergeState, ReviewRequest } from '../../../shared/protocol/pull-requests';

const BLOCKED_REASONS: Record<string, string> = {
  BLOCKED: 'Blocked',
  BEHIND: 'Behind',
  DIRTY: 'Conflicts',
  UNSTABLE: 'Checks failing',
};

type Standing = Pick<ReviewRequest, 'merge' | 'mergeReason'>;

function standing(mergeStateStatus: string, reviewDecision: string | null): Standing {
  if (mergeStateStatus === 'CLEAN' || mergeStateStatus === 'HAS_HOOKS') return { merge: 'ready', mergeReason: null };
  if (mergeStateStatus === 'DRAFT') return { merge: 'draft', mergeReason: null };
  // Branch protection blocks a PR nobody has reviewed yet, which is waiting on a review rather than broken.
  if (mergeStateStatus === 'BLOCKED' && reviewDecision === 'REVIEW_REQUIRED') return { merge: 'review', mergeReason: null };
  if (mergeStateStatus === 'BLOCKED' && reviewDecision === 'CHANGES_REQUESTED') return { merge: 'blocked', mergeReason: 'Changes requested' };
  if (mergeStateStatus in BLOCKED_REASONS) return { merge: 'blocked', mergeReason: BLOCKED_REASONS[mergeStateStatus] };
  return { merge: 'unknown', mergeReason: null };
}

export type Lookup = Standing & Pick<ReviewRequest, 'branch' | 'needsReReview' | 'approved' | 'ci'>;

interface PullRequestNode {
  url: string;
  headRefName?: string;
  mergeStateStatus: string;
  reviewDecision: string | null;
  headRefOid?: string;
  latestReviews?: { nodes?: { author?: { login: string } | null; state: string; commit?: { oid: string } | null }[] } | null;
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state: string } | null } | null }[] } | null;
}

const CI_STATES: Record<string, CiState> = { SUCCESS: 'passing', FAILURE: 'failing', ERROR: 'failing', PENDING: 'pending', EXPECTED: 'pending' };

/** A state GitHub adds later reads as pending: "cannot say" must never look like "fine". */
function ciOf(pr: PullRequestNode): CiState | null {
  const state = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  return state === undefined ? null : (CI_STATES[state] ?? 'pending');
}

/** Your latest review on the PR, if you have one. */
function viewerReview(pr: PullRequestNode, viewer: string | undefined) {
  return pr.latestReviews?.nodes?.find((review) => viewer !== undefined && review.author?.login.toLowerCase() === viewer.toLowerCase());
}

/**
 * Your latest review asked for changes or commented, and the PR's head has moved on from the commit it was on. An approval
 * does not count: a push after one is new work, not your comments answered. A missing commit on either side is no answer.
 */
function needsReReview(pr: PullRequestNode, viewer: string | undefined): boolean {
  const mine = viewerReview(pr, viewer);
  if (!mine || (mine.state !== 'CHANGES_REQUESTED' && mine.state !== 'COMMENTED')) return false;
  const reviewed = mine.commit?.oid ?? '';
  return reviewed !== '' && !!pr.headRefOid && reviewed !== pr.headRefOid;
}

/** Your latest review on the PR is an approval. */
function approvedByViewer(pr: PullRequestNode, viewer: string | undefined): boolean {
  return viewerReview(pr, viewer)?.state === 'APPROVED';
}

/** Reads the response of `mergeStatusQuery`; PRs missing from it, e.g. in a repo the token cannot see, stay unknown. */
export function parseMergeStatuses(json: string): Map<string, Lookup> {
  const parsed = JSON.parse(json) as {
    data?: ({ viewer?: { login: string } } & Record<string, { pullRequest?: PullRequestNode | null } | { login: string } | null | undefined>) | null;
  };
  const viewer = parsed.data?.viewer?.login;
  const result = new Map<string, Lookup>();
  for (const lookup of Object.values(parsed.data ?? {})) {
    const pr = (lookup as { pullRequest?: PullRequestNode | null } | null)?.pullRequest;
    if (!pr) continue;
    result.set(pr.url, {
      ...standing(pr.mergeStateStatus, pr.reviewDecision),
      branch: pr.headRefName ?? '',
      needsReReview: needsReReview(pr, viewer),
      approved: approvedByViewer(pr, viewer),
      ci: ciOf(pr),
    });
  }
  return result;
}

const TICKET = /[A-Z][A-Z0-9]*-\d+/;

interface GhPullRequest {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  author: { login: string };
  isDraft: boolean;
  updatedAt: string;
}

/** A bracketed key in a PR title names its parent, so a key outside brackets wins. */
export function ticketFromTitle(title: string): string | null {
  return (title.replace(/\[[^\]]*\]/g, ' ').match(TICKET) ?? title.match(TICKET))?.[0] ?? null;
}

/** Merges one or more gh search results; a PR found by more than one search appears once. */
export function parseReviewRequests(jsons: readonly string[]): ReviewRequest[] {
  const byUrl = new Map<string, GhPullRequest>();
  for (const json of jsons) {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) throw new Error(`unexpected gh output: ${json.slice(0, 200)}`);
    for (const pr of raw as GhPullRequest[]) byUrl.set(pr.url, pr);
  }
  return [...byUrl.values()]
    .map((pr) => ({
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author.login,
      isDraft: pr.isDraft,
      updatedAt: pr.updatedAt,
      ticket: ticketFromTitle(pr.title),
      branch: '',
      merge: (pr.isDraft ? 'draft' : 'unknown') as MergeState,
      mergeReason: null,
      needsReReview: false,
      approved: false,
      ci: null,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
