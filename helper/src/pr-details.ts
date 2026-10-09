import { MAX_PR_BODY, PR_COMMITS_SHOWN, PR_FILES_SHOWN, type BranchPr, type PrDetails } from '../../shared/protocol';

/** Runs with the PR url in `$CW_PR_URL`, so the url never becomes shell syntax. */
export const GH_PR_DETAILS =
  'gh pr view "$CW_PR_URL" --json title,url,author,headRefName,baseRefName,isDraft,additions,deletions,changedFiles,reviewDecision,mergeable,createdAt,updatedAt,latestReviews,reviewRequests,statusCheckRollup,body,labels,comments,files,commits';

interface GhCheck {
  __typename: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
}

interface GhPrView {
  title: string;
  url: string;
  author: { login: string };
  headRefName: string;
  baseRefName: string;
  isDraft: boolean;
  additions: number;
  deletions: number;
  changedFiles: number;
  reviewDecision: string;
  mergeable: string;
  createdAt: string;
  updatedAt: string;
  latestReviews: { author: { login: string }; state: string; submittedAt?: string }[] | null;
  reviewRequests: { login?: string; name?: string; slug?: string }[] | null;
  statusCheckRollup: GhCheck[] | null;
  body: string | null;
  labels: { name: string }[] | null;
  comments: unknown[] | null;
  files: { path: string; additions: number; deletions: number }[] | null;
  commits: { oid: string; messageHeadline: string; committedDate: string; authors: { login?: string; name?: string }[] }[] | null;
}


const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const PENDING_STATES = new Set(['PENDING', 'EXPECTED']);

function checkResult(check: GhCheck): 'passed' | 'failed' | 'pending' {
  // Check runs report status/conclusion; commit statuses report a single state.
  if (check.__typename === 'StatusContext') {
    if (check.state === 'SUCCESS') return 'passed';
    return PENDING_STATES.has(check.state ?? '') ? 'pending' : 'failed';
  }
  if (check.status !== 'COMPLETED') return 'pending';
  return PASSED.has(check.conclusion ?? '') ? 'passed' : 'failed';
}

/** Counts a PR's checks, naming the failing ones. */
export function summarizeChecks(rollup: readonly GhCheck[] | null | undefined): PrDetails['checks'] {
  const checks = { passed: 0, failed: 0, pending: 0, failing: [] as string[] };
  for (const check of rollup ?? []) {
    const result = checkResult(check);
    checks[result]++;
    if (result === 'failed') checks.failing.push(check.name ?? check.context ?? 'unnamed check');
  }
  return checks;
}

/** Runs in a workspace's directory: the pull request for its current branch. */
export const GH_BRANCH_PR = 'gh pr view --json number,title,url,isDraft,reviewDecision,statusCheckRollup';

/** Reads `gh pr view` for a branch: the PR and its checks, or null when the branch has no pull request. */
export function parseBranchChecks(json: string): { pr: BranchPr; checks: PrDetails['checks'] } | null {
  let parsed: { number?: number; title?: string; url?: string; isDraft?: boolean; reviewDecision?: string; statusCheckRollup?: GhCheck[] | null };
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed?.number !== 'number' || typeof parsed.url !== 'string') return null;
  return {
    pr: { number: parsed.number, title: parsed.title ?? '', url: parsed.url, isDraft: parsed.isDraft === true, reviewDecision: parsed.reviewDecision || null },
    checks: summarizeChecks(parsed.statusCheckRollup),
  };
}

export function parsePrDetails(json: string): PrDetails {
  const pr = JSON.parse(json) as GhPrView;
  if (typeof pr !== 'object' || pr === null || Array.isArray(pr) || typeof pr.url !== 'string') {
    throw new Error(`unexpected gh output: ${json.slice(0, 200)}`);
  }
  const checks = summarizeChecks(pr.statusCheckRollup);
  return {
    url: pr.url,
    title: pr.title,
    author: pr.author.login,
    head: pr.headRefName,
    base: pr.baseRefName,
    isDraft: pr.isDraft,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    reviewDecision: pr.reviewDecision || null,
    mergeable: pr.mergeable,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    reviews: (pr.latestReviews ?? []).map((r) => ({ login: r.author.login, state: r.state, at: r.submittedAt ?? null })),
    requested: (pr.reviewRequests ?? []).map((r) => r.login ?? r.name ?? r.slug ?? 'unknown'),
    checks,
    body: (pr.body ?? '').slice(0, MAX_PR_BODY),
    labels: (pr.labels ?? []).map((label) => label.name),
    comments: (pr.comments ?? []).length,
    files: [...(pr.files ?? [])]
      .sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
      .slice(0, PR_FILES_SHOWN)
      .map(({ path, additions, deletions }) => ({ path, additions, deletions })),
    // gh lists commits oldest first.
    commits: [...(pr.commits ?? [])]
      .reverse()
      .slice(0, PR_COMMITS_SHOWN)
      .map((c) => ({ sha: c.oid.slice(0, 7), headline: c.messageHeadline, author: c.authors[0]?.login ?? c.authors[0]?.name ?? 'unknown', date: c.committedDate })),
    commitCount: (pr.commits ?? []).length,
  };
}
