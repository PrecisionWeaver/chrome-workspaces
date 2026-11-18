// Pull requests: the review list and one pull request's details. Shared by the helper and the extension bundle — keep this free of Node imports.

export const MAX_PR_BODY = 6000;

/** GitHub's own enums for a pull request's review decision and whether it merges cleanly. */
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';

export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';

/**
 * Where a PR stands: `ready` can merge now (approved, checks passing, no conflicts), `review` is open
 * and waiting for a review, `draft` is not up for review yet, and `blocked` cannot merge for a stated reason.
 */
export type MergeState = 'ready' | 'review' | 'draft' | 'blocked' | 'unknown';

/** The head commit's checks as a whole; a PR with no checks has none. */
export type CiState = 'passing' | 'failing' | 'pending';

/**
 * Where your own review on a PR stands. `rereview` means your review is what stands in the way of a merge: you asked for
 * changes and the author has pushed since, your review was dismissed, or you have been asked to review again.
 * `new-commits` means you commented and the author has pushed since.
 */
export type MyReview = 'none' | 'rereview' | 'new-commits' | 'changes-requested' | 'commented' | 'approved';

/** An open PR that requests the user's review. */
export interface ReviewRequest {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
  ticket: string | null;
  /** The PR's head branch; empty until the merge lookup has answered. */
  branch: string;
  merge: MergeState;
  /** Why a `blocked` PR cannot merge, in a word or two; null otherwise. */
  mergeReason: string | null;
  myReview: MyReview;
  /** Null when the PR has no checks, or the lookup that carries them failed. */
  ci: CiState | null;
}

export interface ReviewsState {
  items: ReviewRequest[];
  /** Why the last fetch failed; `items` then still holds the last good list. */
  error: string | null;
  fetchedAt: string | null;
  /** A fetch is running; the panel disables its refresh button until it finishes. */
  refreshing: boolean;
}

export interface PrReview {
  login: string;
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, or PENDING. */
  state: string;
  at: string | null;
}

/** One comment in a pull request's review thread. */
export interface PrThreadComment {
  author: string;
  body: string;
  at: string;
  /** Opens the comment on GitHub. */
  url: string;
}

/** A thread of review comments on a line of the diff. */
export interface PrThread {
  path: string;
  /** The line it is on now, or where it was before the code moved; null for a comment on the whole file. */
  line: number | null;
  resolved: boolean;
  /** The code it was written on has since changed. */
  outdated: boolean;
  comments: PrThreadComment[];
}

export interface PrDetails {
  url: string;
  title: string;
  author: string;
  head: string;
  base: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Null when no review is required. */
  reviewDecision: ReviewDecision | null;
  mergeable: MergeableState;
  createdAt: string;
  updatedAt: string;
  /** Each reviewer's latest review. */
  reviews: PrReview[];
  /** Users and teams whose review is still requested. */
  requested: string[];
  checks: { passed: number; failed: number; pending: number; failing: string[] };
  /** The description as written, in GitHub markdown, cut at `MAX_PR_BODY` characters. */
  body: string;
  labels: string[];
  /** Conversation comments, not counting review comments on code. */
  comments: number;
  /** The files with the most changes first, at most `PR_FILES_SHOWN`. */
  files: PrFile[];
  /** Newest first, at most `PR_COMMITS_SHOWN`. */
  commits: PrCommit[];
  commitCount: number;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrCommit {
  sha: string;
  headline: string;
  author: string;
  date: string;
}

export const PR_FILES_SHOWN = 10;

export const PR_COMMITS_SHOWN = 6;
