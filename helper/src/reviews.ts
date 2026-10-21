import type { CiState, MergeState, ReviewRequest, ReviewsState } from '../../shared/protocol';

const GH_FIELDS = '--json number,title,url,repository,author,isDraft,updatedAt';
export const GH_REVIEW_REQUESTS = `gh search prs --review-requested=@me --state=open ${GH_FIELDS} --limit 50`;

/** Every open PR in the watched repos, yours included, for repos where nobody requests reviewers. */
export function ghWatchedPrs(repos: readonly string[]): string {
  return `gh search prs ${repos.map((repo) => `--repo ${repo}`).join(' ')} --state=open ${GH_FIELDS} --limit 100`;
}

/** PRs you have already reviewed, which no longer match a review request; they are listed only if they need another look. */
export function ghReviewedPrs(repos: readonly string[]): string {
  return `gh search prs ${repos.map((repo) => `--repo ${repo}`).join(' ')} --state=open --reviewed-by=@me ${GH_FIELDS} --limit 50`;
}

const SAFE_NAME = /^[\w.-]+$/;

/** GitHub's intermittent 5xx and cut-off replies, which a second try usually gets past. */
const TRANSIENT = /HTTP 50[234]\b|unexpected end of JSON input|unexpected EOF|timed out|i\/o timeout|handshake timeout|connection reset/i;
const RATE_LIMITED = /rate limit|HTTP 429|abuse detection/i;
/** Tries per search before its failure is reported. */
const SEARCH_ATTEMPTS = 3;
/** GitHub asks for at least a minute after a secondary rate limit, then for longer each time. */
const RATE_LIMIT_FIRST_WAIT_MS = 60_000;
const RATE_LIMIT_MAX_WAIT_MS = 15 * 60_000;

/** What gh said, or the error's own text when it said nothing: the message of a failed exec holds the whole command. */
function failureText(error: unknown): string {
  const { stderr } = error as { stderr?: string };
  return stderr?.trim() || (error instanceof Error ? error.message : String(error));
}

export const isTransient = (error: unknown): boolean => TRANSIENT.test(failureText(error));
export const isRateLimited = (error: unknown): boolean => RATE_LIMITED.test(failureText(error));

/** One request per this many PRs: GitHub's answer time grows with the size of the query, and a big one can time out. */
export const MERGE_BATCH = 10;
/** Batches asked at once: several big queries together are what GitHub times out on. */
export const MERGE_CONCURRENCY = 2;

/** Why a lookup failed, in a few words: the log would otherwise hold a stack trace with no reason in it. */
export function describeFailure(error: unknown): string {
  const { killed, stderr } = error as { killed?: boolean; stderr?: string };
  if (killed) return 'timed out';
  const line = (stderr ?? '').trim().split('\n')[0];
  if (line) return line;
  if (error instanceof SyntaxError) return 'GitHub sent a page that was not JSON';
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
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

type Lookup = Standing & Pick<ReviewRequest, 'branch' | 'needsReReview' | 'approved' | 'ci'>;
/** A batch's answer, or how many of its PRs went unread and why. */
type BatchResult = Map<string, Lookup> | { unread: number; reason: string; limited: boolean };

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

/**
 * Your latest review asked for changes or commented, and the PR's head has moved on from the commit it was on. An approval
 * does not count: a push after one is new work, not your comments answered. A missing commit on either side is no answer.
 */
function needsReReview(pr: PullRequestNode, viewer: string | undefined): boolean {
  const mine = pr.latestReviews?.nodes?.find((review) => viewer !== undefined && review.author?.login.toLowerCase() === viewer.toLowerCase());
  if (!mine || (mine.state !== 'CHANGES_REQUESTED' && mine.state !== 'COMMENTED')) return false;
  const reviewed = mine.commit?.oid ?? '';
  return reviewed !== '' && !!pr.headRefOid && reviewed !== pr.headRefOid;
}

/** Your latest review on the PR is an approval. */
function approvedByViewer(pr: PullRequestNode, viewer: string | undefined): boolean {
  const mine = pr.latestReviews?.nodes?.find((review) => viewer !== undefined && review.author?.login.toLowerCase() === viewer.toLowerCase());
  return mine?.state === 'APPROVED';
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

/** Your own open PRs in the given repos, which nobody has requested your review on. */
export function ghOwnPrs(repos: readonly string[]): string {
  return `gh search prs ${repos.map((repo) => `--repo ${repo}`).join(' ')} --state=open --author=@me ${GH_FIELDS} --limit 50`;
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

/** Keeps the review-request list fresh. A failed fetch keeps the last good list and records why. */
export class ReviewsPoller {
  private current: Omit<ReviewsState, 'refreshing'> = { items: [], error: null, fetchedAt: null };
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<() => void>();
  /** While rate-limited, no request reaches GitHub before this time: every attempt would only extend the limit. */
  private pausedUntil = 0;
  private waitMs = 0;
  /** Set when only the merge lookup was rate-limited, so the list itself is fresh. */
  private limitedNotice: string | null = null;
  private readonly fetchReviewed?: () => Promise<string[]>;
  private readonly now: () => number;

  /**
   * `fetchMerge` runs `mergeStatusQuery`'s result; without it, or if it fails, merge states stay unknown.
   * `fetchReviewed` finds PRs you already reviewed, which are listed only when they need another look, and that is
   * learned from `fetchMerge`, so they are left out without it.
   */
  constructor(
    private readonly fetchJson: () => Promise<string[]>,
    private readonly fetchMerge?: (query: string) => Promise<string>,
    /** How long to wait before trying a failed search or batch once more. */
    private readonly retryDelayMs = 1500,
    options: { fetchReviewed?: () => Promise<string[]>; now?: () => number } = {},
  ) {
    this.fetchReviewed = options.fetchReviewed;
    this.now = options.now ?? Date.now;
  }

  state(): ReviewsState {
    return { ...this.current, items: [...this.current.items], refreshing: this.inFlight !== null };
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.now() < this.pausedUntil) return Promise.resolve();
    this.limitedNotice = null;
    this.inFlight = this.fetchLists()
      .then(({ items, reviewedOnly }) => this.withMergeStatus(items, reviewedOnly))
      .then(
        (items) => {
          if (!this.limitedNotice) this.waitMs = this.pausedUntil = 0;
          this.current = { items, error: this.limitedNotice, fetchedAt: new Date().toISOString() };
        },
        (error: unknown) => {
          if (!isRateLimited(error)) console.warn(`could not list review requests: ${describeFailure(error)}`);
          const message = isRateLimited(error) ? this.pauseNotice() : error instanceof Error ? error.message : String(error);
          this.current = { ...this.current, error: message };
        },
      )
      .finally(() => {
        this.inFlight = null;
        for (const listener of this.listeners) listener();
      });
    // Tell the panels now, so they can disable their refresh buttons until this finishes.
    for (const listener of this.listeners) listener();
    return this.inFlight;
  }

  /** Pauses polling for longer each time it is called, and says when it resumes. */
  private pauseNotice(): string {
    this.waitMs = this.waitMs === 0 ? RATE_LIMIT_FIRST_WAIT_MS : Math.min(this.waitMs * 2, RATE_LIMIT_MAX_WAIT_MS);
    this.pausedUntil = this.now() + this.waitMs;
    const at = new Date(this.pausedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    console.warn(`GitHub is rate-limiting; review requests pause for ${this.waitMs / 60_000} min`);
    return `GitHub is rate-limiting requests. Trying again after ${at}.`;
  }

  /** A search, tried again when GitHub answers with a gateway error or a cut-off reply. */
  private async search(fetch: () => Promise<string[]>): Promise<string[]> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fetch();
      } catch (error) {
        if (attempt >= SEARCH_ATTEMPTS || !isTransient(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
  }

  /** The list, and which of its PRs were found only because you reviewed them. */
  private async fetchLists(): Promise<{ items: ReviewRequest[]; reviewedOnly: Set<string> }> {
    const [main, reviewed] = await Promise.all([this.search(this.fetchJson), this.fetchReviewed ? this.search(this.fetchReviewed) : []]);
    const requested = new Set(parseReviewRequests(main).map((item) => item.url));
    const items = parseReviewRequests([...main, ...reviewed]);
    return { items, reviewedOnly: new Set(items.filter((item) => !requested.has(item.url)).map((item) => item.url)) };
  }

  /**
   * The merge states of one batch, or how many PRs could not be read and why. A failed batch is tried once more as two
   * halves, since a smaller query is what gets past a timeout; a rate limit is not tried again.
   */
  private async mergeBatch(items: ReviewRequest[], retry = true): Promise<BatchResult[]> {
    try {
      return [parseMergeStatuses(await this.fetchMerge!(mergeStatusQuery(items)))];
    } catch (error) {
      const failure = { unread: items.length, reason: describeFailure(error), limited: isRateLimited(error) };
      if (!retry || failure.limited) return [failure];
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      if (items.length === 1) return this.mergeBatch(items, false);
      const half = Math.ceil(items.length / 2);
      return (await Promise.all([this.mergeBatch(items.slice(0, half), false), this.mergeBatch(items.slice(half), false)])).flat();
    }
  }

  /** Every batch, a few at a time; once GitHub rate-limits one, the rest are not asked, since asking extends the limit. */
  private async mergeBatches(batches: ReviewRequest[][]): Promise<BatchResult[]> {
    const results: BatchResult[] = [];
    let next = 0;
    let limited = false;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        if (limited) {
          results.push({ unread: batch.length, reason: 'skipped while rate-limited', limited: true });
          continue;
        }
        const batchResults = await this.mergeBatch(batch);
        if (batchResults.some((result) => !(result instanceof Map) && result.limited)) limited = true;
        results.push(...batchResults);
      }
    };
    await Promise.all(Array.from({ length: Math.min(MERGE_CONCURRENCY, batches.length) }, worker));
    return results;
  }

  private async withMergeStatus(items: ReviewRequest[], reviewedOnly: ReadonlySet<string>): Promise<ReviewRequest[]> {
    if (!this.fetchMerge || items.length === 0) return items.filter((item) => !reviewedOnly.has(item.url));
    const batches: ReviewRequest[][] = [];
    for (let i = 0; i < items.length; i += MERGE_BATCH) batches.push(items.slice(i, i + MERGE_BATCH));

    const statuses = new Map<string, Lookup>();
    const failures: string[] = [];
    let unread = 0;
    let limited = false;
    for (const result of await this.mergeBatches(batches)) {
      if (result instanceof Map) {
        for (const [url, lookup] of result) statuses.set(url, lookup);
        continue;
      }
      failures.push(result.reason);
      unread += result.unread;
      limited ||= result.limited;
    }
    if (failures.length) console.warn(`could not read merge states for ${unread} of ${items.length} PRs: ${[...new Set(failures)].join('; ')}`);
    if (limited) this.limitedNotice = this.pauseNotice();

    // A PR whose lookup failed, or that GitHub has not finished working out (it answers UNKNOWN while it computes a
    // PR's mergeability), keeps what the last good lookup said rather than losing its badge until the next poll.
    const before = new Map(this.current.items.map((item) => [item.url, item]));
    return items
      .map((item) => {
        const fresh = statuses.get(item.url);
        const last = before.get(item.url);
        // The review and check signals are the lookup's whenever it answered, whatever the merge state says.
        const signals = fresh
          ? { branch: fresh.branch, needsReReview: fresh.needsReReview, approved: fresh.approved, ci: fresh.ci }
          : { branch: last?.branch ?? '', needsReReview: last?.needsReReview ?? false, approved: last?.approved ?? false, ci: last?.ci ?? null };
        // A draft is a draft whatever else GitHub reports; the search result already says so.
        if (item.isDraft) return { ...item, ...signals };
        if (fresh && fresh.merge !== 'unknown') return { ...item, ...fresh };
        if (last && last.merge !== 'unknown' && last.merge !== 'draft') return { ...item, ...signals, merge: last.merge, mergeReason: last.mergeReason };
        return fresh ? { ...item, ...fresh } : { ...item, ...signals };
      })
      .filter((item) => !reviewedOnly.has(item.url) || item.needsReReview);
  }

  start(intervalMs: number): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
