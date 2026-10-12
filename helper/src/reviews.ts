import type { MergeState, ReviewRequest, ReviewsState } from '../../shared/protocol';

const GH_FIELDS = '--json number,title,url,repository,author,isDraft,updatedAt';
export const GH_REVIEW_REQUESTS = `gh search prs --review-requested=@me --state=open ${GH_FIELDS} --limit 50`;

/** Every open PR in the watched repos, yours included, for repos where nobody requests reviewers. */
export function ghWatchedPrs(repos: readonly string[]): string {
  return `gh search prs ${repos.map((repo) => `--repo ${repo}`).join(' ')} --state=open ${GH_FIELDS} --limit 100`;
}

const SAFE_NAME = /^[\w.-]+$/;

/** One request per this many PRs: GitHub's answer time grows with the size of the query, and a big one can time out. */
export const MERGE_BATCH = 25;

/** Why a lookup failed, in a few words: the log would otherwise hold a stack trace with no reason in it. */
export function describeFailure(error: unknown): string {
  const { killed, stderr } = error as { killed?: boolean; stderr?: string };
  if (killed) return 'timed out';
  const line = (stderr ?? '').trim().split('\n')[0];
  if (line) return line;
  if (error instanceof SyntaxError) return 'GitHub sent a page that was not JSON';
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

/** One GraphQL request for every PR's merge state, which `gh search` does not report. */
export function mergeStatusQuery(items: readonly ReviewRequest[]): string {
  const lookups = items.flatMap((item, index) => {
    const [owner, name] = item.repo.split('/');
    if (!owner || !name || !SAFE_NAME.test(owner) || !SAFE_NAME.test(name)) return [];
    return [`r${index}: repository(owner: "${owner}", name: "${name}") { pullRequest(number: ${item.number}) { url mergeStateStatus reviewDecision } }`];
  });
  return `query { ${lookups.join(' ')} }`;
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

/** Reads the response of `mergeStatusQuery`; PRs missing from it, e.g. in a repo the token cannot see, stay unknown. */
export function parseMergeStatuses(json: string): Map<string, Standing> {
  const parsed = JSON.parse(json) as {
    data?: Record<string, { pullRequest?: { url: string; mergeStateStatus: string; reviewDecision: string | null } | null } | null> | null;
  };
  const result = new Map<string, Standing>();
  for (const lookup of Object.values(parsed.data ?? {})) {
    const pr = lookup?.pullRequest;
    if (!pr) continue;
    result.set(pr.url, standing(pr.mergeStateStatus, pr.reviewDecision));
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
      merge: (pr.isDraft ? 'draft' : 'unknown') as MergeState,
      mergeReason: null,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Keeps the review-request list fresh. A failed fetch keeps the last good list and records why. */
export class ReviewsPoller {
  private current: Omit<ReviewsState, 'refreshing'> = { items: [], error: null, fetchedAt: null };
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<() => void>();

  /** `fetchMerge` runs `mergeStatusQuery`'s result; without it, or if it fails, merge states stay unknown. */
  constructor(
    private readonly fetchJson: () => Promise<string[]>,
    private readonly fetchMerge?: (query: string) => Promise<string>,
    /** How long to wait before trying a failed batch once more. */
    private readonly retryDelayMs = 1500,
  ) {}

  state(): ReviewsState {
    return { ...this.current, items: [...this.current.items], refreshing: this.inFlight !== null };
  }

  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchJson()
      .then(parseReviewRequests)
      .then((items) => this.withMergeStatus(items))
      .then(
        (items) => {
          this.current = { items, error: null, fetchedAt: new Date().toISOString() };
        },
        (error: unknown) => {
          this.current = { ...this.current, error: error instanceof Error ? error.message : String(error) };
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

  /** The merge states of one batch, tried twice, or the reason it could not be read. */
  private async mergeBatch(items: ReviewRequest[]): Promise<Map<string, Standing> | string> {
    let failure = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      try {
        return parseMergeStatuses(await this.fetchMerge!(mergeStatusQuery(items)));
      } catch (error) {
        failure = describeFailure(error);
      }
    }
    return failure;
  }

  private async withMergeStatus(items: ReviewRequest[]): Promise<ReviewRequest[]> {
    if (!this.fetchMerge || items.length === 0) return items;
    const batches: ReviewRequest[][] = [];
    for (let i = 0; i < items.length; i += MERGE_BATCH) batches.push(items.slice(i, i + MERGE_BATCH));
    const results = await Promise.all(batches.map((batch) => this.mergeBatch(batch)));

    const statuses = new Map<string, Standing>();
    const failures: string[] = [];
    let unread = 0;
    results.forEach((result, index) => {
      if (typeof result === 'string') {
        failures.push(result);
        unread += batches[index].length;
      } else for (const [url, standing] of result) statuses.set(url, standing);
    });
    if (failures.length) console.warn(`could not read merge states for ${unread} of ${items.length} PRs: ${[...new Set(failures)].join('; ')}`);

    // A PR whose lookup failed, or that GitHub has not finished working out (it answers UNKNOWN while it computes a
    // PR's mergeability), keeps what the last good lookup said rather than losing its badge until the next poll.
    const before = new Map(this.current.items.map((item) => [item.url, item]));
    return items.map((item) => {
      // A draft is a draft whatever else GitHub reports; the search result already says so.
      if (item.isDraft) return item;
      const fresh = statuses.get(item.url);
      if (fresh && fresh.merge !== 'unknown') return { ...item, ...fresh };
      const last = before.get(item.url);
      return last && last.merge !== 'unknown' && last.merge !== 'draft'
        ? { ...item, merge: last.merge, mergeReason: last.mergeReason }
        : fresh
          ? { ...item, ...fresh }
          : item;
    });
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
