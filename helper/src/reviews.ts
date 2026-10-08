import type { ReviewRequest, ReviewsState } from '../../shared/protocol';

const GH_FIELDS = '--json number,title,url,repository,author,isDraft,updatedAt';
export const GH_REVIEW_REQUESTS = `gh search prs --review-requested=@me --state=open ${GH_FIELDS} --limit 50`;

/** Every open PR in the watched repos except your own, for repos where nobody requests reviewers. */
export function ghWatchedPrs(repos: readonly string[]): string {
  return `gh search prs ${repos.map((repo) => `--repo ${repo}`).join(' ')} --state=open ${GH_FIELDS} --limit 100 -- -author:@me`;
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
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Keeps the review-request list fresh. A failed fetch keeps the last good list and records why. */
export class ReviewsPoller {
  private current: ReviewsState = { items: [], error: null, fetchedAt: null };
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly fetchJson: () => Promise<string[]>) {}

  state(): ReviewsState {
    return { ...this.current, items: [...this.current.items] };
  }

  refresh(): Promise<void> {
    this.inFlight ??= this.fetchJson()
      .then(parseReviewRequests)
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
