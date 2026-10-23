import type { CiState, ControlToHelper, MergeState, ReviewRequest, ReviewsState, Workspace } from '../../shared/protocol';
import { $, el } from './dom';
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

type Facet = 'author' | 'repo' | 'status';
const FACETS: readonly Facet[] = ['author', 'repo', 'status'];
const FACET_LABELS: Record<Facet, string> = { author: 'Authors', repo: 'Repos', status: 'Status' };
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

const CI_LABELS: Record<CiState, string> = { passing: 'Checks passing', failing: 'Checks failing', pending: 'Checks running' };

/** What a request is filtered on for a facet; a PR that cannot merge is filtered by why, such as Conflicts. */
const facetValue = (item: ReviewRequest, facet: Facet): string =>
  facet === 'status' ? (item.merge === 'blocked' && item.mergeReason ? item.mergeReason : MERGE_LABELS[item.merge]) : item[facet];

/** Every word of the query must appear somewhere in the request. */
function matches(item: ReviewRequest, query: string): boolean {
  const haystack = `${ref(item)} ${item.repo} ${item.title} ${item.author} ${item.ticket ?? ''} ${item.branch}${item.isDraft ? ' draft' : ''}`.toLowerCase();
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
  const hidden: Record<Facet, Set<string>> = { author: new Set(), repo: new Set(), status: new Set() };
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
    void chrome.storage.local.set({ reviewsHidden: { author: [...hidden.author], repo: [...hidden.repo], status: [...hidden.status] } });
    renderReviews(lastReviews, lastWorkspaces);
  }

  $<HTMLButtonElement>('reviews-toggle').addEventListener('click', () => {
    const collapsed = reviewsSection.classList.toggle('collapsed');
    void chrome.storage.local.set({ reviewsCollapsed: collapsed });
  });

  void chrome.storage.local.get(['reviewsCollapsed', 'reviewsHidden']).then(({ reviewsCollapsed, reviewsHidden }) => {
    reviewsSection.classList.toggle('collapsed', reviewsCollapsed === true);
    const saved = reviewsHidden as Partial<Record<Facet, string[]>> | undefined;
    for (const facet of FACETS) for (const value of saved?.[facet] ?? []) hidden[facet].add(value);
    renderReviews(lastReviews, lastWorkspaces);
  });

  /** Updates the Authors and Repos buttons, and the checklist for whichever is open. */
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

  function renderReviews(state: ReviewsState, workspaces: readonly Workspace[]): void {
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
    reviewsList.replaceChildren(
      ...items.map((item) => {
        const existing = workspaces.find((ws) => ws.pr === item.url);
        const row = document.createElement('li');
        row.className = `review${item.url === selectedUrl() ? ' selected' : ''}`;
        row.title = `${item.title}\n${item.repo} by ${item.author}${existing ? `\nWorkspace: ${existing.name}` : ''}`;

        const head = document.createElement('span');
        head.className = 'ref';
        head.append(el('code', ref(item)));
        if (item.merge !== 'unknown') {
          const blocked = item.merge === 'blocked';
          const merge = el('span', blocked ? (item.mergeReason ?? MERGE_LABELS.blocked) : MERGE_LABELS[item.merge], `merge ${item.merge}`);
          merge.title = MERGE_TITLES[item.merge] ?? `Cannot merge yet: ${item.mergeReason ?? 'blocked'}`;
          head.append(merge);
        }
        if (item.approved) {
          const approved = el('span', 'Approved', 'approved');
          approved.title = 'You approved this PR';
          head.append(approved);
        }
        if (item.needsReReview) {
          const again = el('span', 'New commits', 'rereview');
          again.title = 'You reviewed this PR, and the author has pushed since';
          head.append(again);
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
        row.addEventListener('click', () => {
          if (item.url === selectedUrl()) closeCreate();
          else if (existing) openWorkspace(existing);
          else create(item);
        });
        return row;
      }),
    );
  }

  return { renderReviews };
}
