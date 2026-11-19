import type { ControlToHelper } from '../../../shared/protocol/protocol';
import type { Workspace } from '../../../shared/protocol/workspace';
import type { CiState, MergeState, MyReview, ReviewRequest, ReviewsState } from '../../../shared/protocol/pull-requests';
import { $, el } from '../ui/dom';
import { collapsible } from '../ui/collapsible';
import { ref, relative, byline } from './pr-view';

export interface LauncherOptions {
  send(message: ControlToHelper): boolean;
  /** Opens the new-workspace view for a review request. */
  create(review: ReviewRequest): void;
  /** Closes the new-workspace view. */
  closeCreate(): void;
  /** The review request the new-workspace view is open for, if any. */
  selectedUrl(): string | null;
  openWorkspace(workspace: Workspace): void;
}

export interface Launcher {
  renderReviews(state: ReviewsState, workspaces: readonly Workspace[]): void;
}

type Facet = 'author' | 'repo' | 'status' | 'mine';
const FACETS: readonly Facet[] = ['author', 'repo', 'status', 'mine'];
const FACET_LABELS: Record<Facet, string> = { author: 'Authors', repo: 'Repos', status: 'Status', mine: 'My review' };
const MERGE_LABELS: Record<MergeState, string> = {
  ready: 'Can merge',
  review: 'Ready for review',
  draft: 'Draft',
  blocked: "Can't merge",
  unknown: 'Unknown',
};
const MERGE_TITLES: Partial<Record<MergeState, string>> = {
  ready: 'Approved, checks passing, no conflicts',
  review: 'Not a draft, and waiting for a review',
  draft: 'Draft: not up for review yet',
};

const MY_REVIEW_LABELS: Record<MyReview, string> = {
  rereview: 'Re-review to merge',
  'new-commits': 'New commits',
  'changes-requested': 'Changes requested',
  commented: 'Commented',
  approved: 'Approved',
  none: 'Not reviewed',
};
const MY_REVIEW_TITLES: Record<Exclude<MyReview, 'none'>, string> = {
  rereview: 'Your review is needed again before this can merge',
  'new-commits': 'You commented on this PR, and the author has pushed since',
  'changes-requested': 'You asked for changes; waiting on the author',
  commented: 'You commented on this PR',
  approved: 'You approved this PR',
};

const CI_LABELS: Record<CiState, string> = { passing: 'Checks passing', failing: 'Checks failing', pending: 'Checks running' };

/** What a request is filtered on for a facet; a PR that cannot merge is filtered by why, such as Conflicts. */
function facetValue(item: ReviewRequest, facet: Facet): string {
  if (facet === 'status') return item.merge === 'blocked' && item.mergeReason ? item.mergeReason : MERGE_LABELS[item.merge];
  return facet === 'mine' ? MY_REVIEW_LABELS[item.myReview] : item[facet];
}

/** Every word of the query must appear somewhere in the request. */
function matches(item: ReviewRequest, query: string): boolean {
  const haystack =
    `${ref(item)} ${item.repo} ${item.title} ${item.author} ${item.ticket ?? ''} ${item.branch}${item.isDraft ? ' draft' : ''}${item.myReview === 'none' ? '' : ` ${MY_REVIEW_LABELS[item.myReview]}`}`.toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

export function createLauncher({ send, create, closeCreate, selectedUrl, openWorkspace }: LauncherOptions): Launcher {
  const reviewsSection = $<HTMLElement>('reviews');
  const reviewsTitle = $<HTMLSpanElement>('reviews-title');
  const reviewsError = $<HTMLDivElement>('reviews-error');
  const reviewsList = $<HTMLUListElement>('reviews-list');
  const reviewsSearch = $<HTMLInputElement>('reviews-search');
  const reviewsFacet = $<HTMLDivElement>('reviews-facet');
  const facetButtons = [...document.querySelectorAll<HTMLButtonElement>('#reviews-tools .facet')];
  const reviewsRefresh = $<HTMLButtonElement>('reviews-refresh');

  let lastReviews: ReviewsState = { items: [], error: null, fetchedAt: null, refreshing: false };
  let lastWorkspaces: readonly Workspace[] = [];
  // Deselected values are stored rather than selected ones, so new authors and repos show up.
  const hidden: Record<Facet, Set<string>> = { author: new Set(), repo: new Set(), status: new Set(), mine: new Set() };
  let openFacet: Facet | null = null;

  // Registered before the new-workspace view's own Escape handler, so closing a facet list is not also a close.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !openFacet) return;
    event.stopImmediatePropagation();
    openFacet = null;
    renderReviews(lastReviews, lastWorkspaces);
  });

  reviewsRefresh.addEventListener('click', () => send({ type: 'refreshReviews' }));

  reviewsSearch.addEventListener('input', () => renderReviews(lastReviews, lastWorkspaces));
  reviewsSearch.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    reviewsSearch.value = '';
    renderReviews(lastReviews, lastWorkspaces);
  });

  for (const button of facetButtons) {
    button.addEventListener('click', () => {
      const facet = button.dataset.facet as Facet;
      openFacet = openFacet === facet ? null : facet;
      renderReviews(lastReviews, lastWorkspaces);
    });
  }

  function setHidden(facet: Facet, values: Iterable<string>, hide: boolean): void {
    for (const value of values) hidden[facet][hide ? 'add' : 'delete'](value);
    void chrome.storage.local.set({ reviewsHidden: Object.fromEntries(FACETS.map((key) => [key, [...hidden[key]]])) });
    renderReviews(lastReviews, lastWorkspaces);
  }

  collapsible({ section: reviewsSection, toggle: $<HTMLButtonElement>('reviews-toggle'), storageKey: 'reviewsCollapsed' });

  void chrome.storage.local.get('reviewsHidden').then(({ reviewsHidden }) => {
    const saved = reviewsHidden as Partial<Record<Facet, string[]>> | undefined;
    for (const facet of FACETS) for (const value of saved?.[facet] ?? []) hidden[facet].add(value);
    renderReviews(lastReviews, lastWorkspaces);
  });

  /** Updates the facet buttons, and the checklist for whichever is open. */
  function renderFacets(items: readonly ReviewRequest[]): void {
    for (const button of facetButtons) {
      const facet = button.dataset.facet as Facet;
      const values = new Set(items.map((item) => facetValue(item, facet)));
      const shown = [...values].filter((value) => !hidden[facet].has(value)).length;
      button.textContent = shown === values.size ? FACET_LABELS[facet] : `${FACET_LABELS[facet]} ${shown}/${values.size}`;
      button.classList.toggle('active', shown !== values.size);
      button.classList.toggle('open', facet === openFacet);
    }
    reviewsFacet.hidden = openFacet === null;
    if (!openFacet) return;
    const facet = openFacet;
    const counts = new Map<string, number>();
    for (const item of items) counts.set(facetValue(item, facet), (counts.get(facetValue(item, facet)) ?? 0) + 1);
    const values = [...counts.keys()].sort((a, b) => a.localeCompare(b));

    const bulk = el('div', '', 'facet-bulk');
    const all = el('button', 'All');
    const none = el('button', 'None');
    all.type = none.type = 'button';
    all.addEventListener('click', () => setHidden(facet, values, false));
    none.addEventListener('click', () => setHidden(facet, values, true));
    bulk.append(all, none);

    reviewsFacet.replaceChildren(
      bulk,
      ...values.map((value) => {
        const row = el('label', '', 'facet-option');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = !hidden[facet].has(value);
        box.addEventListener('change', () => setHidden(facet, [value], !box.checked));
        const name = el('span', facet === 'repo' ? (value.split('/')[1] ?? value) : value, 'facet-name');
        name.title = value;
        row.append(box, name, el('span', `${counts.get(value)}`, 'facet-count'));
        return row;
      }),
    );
  }

  /** What the last draw was made from, outside the view's own search and facets (which always redraw): a state message that changes none of it leaves the rows as they are. */
  let drawnKey = '';

  /** Redraws only when the reviews, the workspaces they match or the selected row differ from the last draw; every hook event sends a state message. */
  function renderIfChanged(state: ReviewsState, workspaces: readonly Workspace[]): void {
    const key = `${JSON.stringify(state)}|${workspaces.map((ws) => `${ws.id}=${ws.pr ?? ''}=${ws.name}`).join(',')}|${selectedUrl() ?? ''}`;
    if (key === drawnKey) return;
    renderReviews(state, workspaces);
    drawnKey = key;
  }

  function renderReviews(state: ReviewsState, workspaces: readonly Workspace[]): void {
    drawnKey = '';
    lastReviews = state;
    lastWorkspaces = workspaces;
    const query = reviewsSearch.value.trim().toLowerCase();
    const items = state.items.filter((item) => FACETS.every((facet) => !hidden[facet].has(facetValue(item, facet))) && (!query || matches(item, query)));
    renderFacets(state.items);
    const count = items.length === state.items.length ? `${items.length}` : `${items.length} of ${state.items.length}`;
    reviewsTitle.textContent = `Review requests (${count})`;
    reviewsRefresh.disabled = state.refreshing;
    reviewsRefresh.title = state.fetchedAt ? `Refresh review requests (updated ${relative(state.fetchedAt)})` : 'Refresh review requests';
    reviewsError.hidden = state.error === null;
    reviewsError.textContent = state.error?.split('\n')[0] ?? '';
    reviewsError.title = state.error ?? '';
    const empty = items.length === 0 ? emptyReviewsMessage(state, query) : null;
    reviewsList.replaceChildren(
      ...(empty ? [el('li', empty, 'review-empty')] : []),
      ...items.map((item) => {
        const existing = workspaces.find((ws) => ws.pr === item.url);
        const row = document.createElement('li');
        row.className = `review${item.url === selectedUrl() ? ' selected' : ''}`;
        row.title = `${item.title}\n${item.repo} by ${item.author}${existing ? `\nWorkspace: ${existing.name}` : ''}`;
        // Reachable and openable from the keyboard, like the workspace rows.
        row.tabIndex = 0;
        row.setAttribute('role', 'button');

        const head = document.createElement('span');
        head.className = 'ref';
        head.append(el('code', ref(item)));
        if (item.merge !== 'unknown') {
          const blocked = item.merge === 'blocked';
          const merge = el('span', blocked ? (item.mergeReason ?? MERGE_LABELS.blocked) : MERGE_LABELS[item.merge], 'merge');
          merge.dataset.state = item.merge;
          merge.title = MERGE_TITLES[item.merge] ?? `Cannot merge yet: ${item.mergeReason ?? 'blocked'}`;
          head.append(merge);
        }
        if (item.myReview !== 'none') {
          const mine = el('span', MY_REVIEW_LABELS[item.myReview], 'mine');
          mine.dataset.state = item.myReview;
          mine.title = MY_REVIEW_TITLES[item.myReview];
          head.append(mine);
        }
        // "Can merge" already says the checks pass, and a blocked PR's reason may already say they fail.
        if (item.ci && item.merge !== 'ready' && !(item.ci === 'failing' && item.mergeReason === 'Checks failing')) {
          head.append(el('span', CI_LABELS[item.ci], `ci ${item.ci}`));
        }
        if (existing) {
          const dot = document.createElement('span');
          dot.className = 'has-workspace';
          head.append(dot);
        }

        const itemTitle = document.createElement('span');
        itemTitle.className = 'title';
        itemTitle.textContent = item.title;

        const when = byline(relative(item.updatedAt), item.author);
        row.append(head, itemTitle, when);
        const open = () => {
          if (item.url === selectedUrl()) closeCreate();
          else if (existing) openWorkspace(existing);
          else create(item);
        };
        row.addEventListener('click', open);
        row.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          open();
        });
        return row;
      }),
    );
  }

  return { renderReviews: renderIfChanged };
}

/** What the list says when it has no rows: still loading, nothing to review, or everything filtered out. */
function emptyReviewsMessage(state: ReviewsState, query: string): string {
  if (state.items.length > 0) return query ? 'No review requests match.' : 'No review requests match the filters.';
  if (state.fetchedAt === null) return state.error ? 'Could not load review requests.' : 'Loading review requests…';
  return 'No review requests.';
}
