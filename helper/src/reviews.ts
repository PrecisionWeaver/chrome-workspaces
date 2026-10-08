import type { MergeState, ReviewRequest, ReviewsState } from '../../shared/protocol';

const GH_FIELDS = '--json number,title,url,repository,author,isDraft,updatedAt';
export const GH_REVIEW_REQUESTS = `gh search prs --review-requested=@me --state=open ${GH_FIELDS} --limit 50`;

/** Every open PR in the watched repos, yours included, for repos where nobody requests reviewers. */
export function ghWatchedPrs(repos: readonly string[]): string {
  return `gh search prs ${repos.map((repo) => `--repo ${repo}`).join(' ')} --state=open ${GH_FIELDS} --limit 100`;
}

const SAFE_NAME = /^[\w.-]+$/;

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
  const parsed = JSON.parse(json) as { data?: Record<string, { pullRequest?: { url: string; mergeStateStatus: string; reviewDecision: string | null } | null } | null> | null };
  const result = new Map<string, Standing>();
  for (const lookup of Object.values(parsed.data ?? {})) {
    const pr = lookup?.pullRequest;
    if (!pr) continue;
    result.set(pr.url, standing(pr.mergeStateStatus, pr.reviewDecision));
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
      merge: (pr.isDraft ? 'draft' : 'unknown') as MergeState,
      mergeReason: null,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Keeps the review-request list fresh. A failed fetch keeps the last good list and records why. */
export class ReviewsPoller {
  private current: ReviewsState = { items: [], error: null, fetchedAt: null };
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<() => void>();

  /** `fetchMerge` runs `mergeStatusQuery`'s result; without it, or if it fails, merge states stay unknown. */
  constructor(
    private readonly fetchJson: () => Promise<string[]>,
    private readonly fetchMerge?: (query: string) => Promise<string>,
  ) {}

  state(): ReviewsState {
    return { ...this.current, items: [...this.current.items] };
  }

  refresh(): Promise<void> {
    this.inFlight ??= this.fetchJson()
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
    return this.inFlight;
  }

  private async withMergeStatus(items: ReviewRequest[]): Promise<ReviewRequest[]> {
    if (!this.fetchMerge || items.length === 0) return items;
    try {
      const statuses = parseMergeStatuses(await this.fetchMerge(mergeStatusQuery(items)));
      // A draft is a draft whatever else GitHub reports; the search result already says so.
      return items.map((item) => ({ ...item, ...(item.isDraft ? {} : statuses.get(item.url)) }));
    } catch (error) {
      console.warn('could not read merge states', error);
      return items;
    }
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
