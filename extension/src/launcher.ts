import { fillPrompt } from '../../shared/prompts';
import type { ControlToHelper, PrDetails, Prompt, ReviewRequest, ReviewsState, Workspace } from '../../shared/protocol';
import { el, promptCard } from './dom';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface LauncherOptions {
  send(message: ControlToHelper): boolean;
  /** Called when the launch view opens or closes, so the panel can swap it with the terminal. */
  onToggle(): void;
  openWorkspace(workspace: Workspace): void;
  /** The window this panel is in, and the workspace it holds, if any. */
  here(): { windowId: number | undefined; workspace: Workspace | undefined };
}

export interface Launcher {
  readonly isOpen: boolean;
  /** Opens the prompt picker for a review request. */
  show(review: ReviewRequest): void;
  /** Returns to the terminal. */
  close(): void;
  renderReviews(state: ReviewsState, workspaces: readonly Workspace[]): void;
  setPrompts(prompts: Prompt[], error: string | null): void;
  setPrDetails(url: string, details: PrDetails | null, error: string | null): void;
}

const repoName = (review: ReviewRequest) => review.repo.split('/')[1] ?? review.repo;
const ref = (review: ReviewRequest) => `${repoName(review)}#${review.number}`;

const DECISIONS: Record<string, [label: string, tone: string]> = {
  APPROVED: ['Approved', 'good'],
  CHANGES_REQUESTED: ['Changes requested', 'bad'],
  REVIEW_REQUIRED: ['Review required', 'wait'],
};
const REVIEW_STATES: Record<string, [label: string, tone: string]> = {
  APPROVED: ['approved', 'good'],
  CHANGES_REQUESTED: ['requested changes', 'bad'],
  COMMENTED: ['commented', ''],
  DISMISSED: ['dismissed', ''],
  PENDING: ['review in progress', 'wait'],
};

function relative(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function person(login: string, trailing?: Node): HTMLElement {
  const row = el('li', '', 'person');
  row.append(el('span', login.slice(0, 1).toUpperCase(), 'avatar'), el('span', login, 'login'));
  if (trailing) row.append(trailing);
  return row;
}

function renderDetails(pr: PrDetails): Node[] {
  const branches = el('div', '', 'branches');
  branches.append(el('code', pr.head), el('span', '→', 'arrow'), el('code', pr.base));

  const stats = el('div', '', 'stats');
  stats.append(
    el('span', `+${pr.additions.toLocaleString()}`, 'add'),
    el('span', `−${pr.deletions.toLocaleString()}`, 'del'),
    el('span', `${pr.changedFiles} files`, 'files'),
    el('span', `by ${pr.author} · opened ${relative(pr.createdAt)} · updated ${relative(pr.updatedAt)}`, 'when'),
  );

  const pills = el('div', '', 'pills');
  const [label, tone] = DECISIONS[pr.reviewDecision ?? ''] ?? ['No review required', ''];
  pills.append(el('span', label, `pill ${tone}`));
  if (pr.isDraft) pills.append(el('span', 'Draft', 'pill'));
  if (pr.mergeable === 'CONFLICTING') pills.append(el('span', 'Merge conflicts', 'pill bad'));
  const { passed, failed, pending, failing } = pr.checks;
  if (failed) pills.append(el('span', `${failed} failing`, 'pill bad'));
  if (pending) pills.append(el('span', `${pending} pending`, 'pill wait'));
  if (passed) pills.append(el('span', `${passed} passed`, 'pill good'));

  const nodes: Node[] = [branches, stats, pills];
  if (failing.length) {
    const failingEl = el('div', 'Failing: ', 'failing');
    failingEl.append(el('span', failing.join(', ')));
    nodes.push(failingEl);
  }

  const people = el('div', '', 'people');
  const reviewed = el('div', '', 'people-col');
  reviewed.append(el('h3', 'Reviews'));
  const reviewList = el('ul');
  if (pr.reviews.length === 0) reviewList.append(el('li', 'None yet', 'empty'));
  for (const r of pr.reviews) {
    const [stateLabel, stateTone] = REVIEW_STATES[r.state] ?? [r.state.toLowerCase(), ''];
    const row = person(r.login, el('span', stateLabel, `state ${stateTone}`));
    if (r.at) row.title = new Date(r.at).toLocaleString();
    reviewList.append(row);
  }
  reviewed.append(reviewList);
  people.append(reviewed);

  if (pr.requested.length) {
    const waiting = el('div', '', 'people-col');
    waiting.append(el('h3', `Waiting on ${pr.requested.length}`));
    const waitingList = el('ul');
    waitingList.append(...pr.requested.map((login) => person(login)));
    waiting.append(waitingList);
    people.append(waiting);
  }
  nodes.push(people);
  return nodes;
}

type Facet = 'author' | 'repo';
const FACET_LABELS: Record<Facet, string> = { author: 'Authors', repo: 'Repos' };

/** Every word of the query must appear somewhere in the request. */
function matches(item: ReviewRequest, query: string): boolean {
  const haystack = `${ref(item)} ${item.repo} ${item.title} ${item.author} ${item.ticket ?? ''}${item.isDraft ? ' draft' : ''}`.toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

export function createLauncher({ send, onToggle, openWorkspace, here }: LauncherOptions): Launcher {
  const section = $<HTMLElement>('launch');
  const choose = $<HTMLDivElement>('launch-choose');
  const title = $<HTMLHeadingElement>('launch-title');
  const filter = $<HTMLInputElement>('launch-filter');
  const detailsEl = $<HTMLDivElement>('launch-details');
  const githubButton = $<HTMLButtonElement>('launch-github');
  const errorEl = $<HTMLDivElement>('launch-error');
  const promptsEl = $<HTMLDivElement>('launch-prompts');
  const editForm = $<HTMLFormElement>('launch-edit');
  const nameInput = $<HTMLInputElement>('launch-name');
  const textInput = $<HTMLTextAreaElement>('launch-text');
  const hereInput = $<HTMLInputElement>('launch-here');
  const hereLabel = $<HTMLSpanElement>('launch-here-label');
  const reviewsSection = $<HTMLElement>('reviews');
  const reviewsTitle = $<HTMLSpanElement>('reviews-title');
  const reviewsError = $<HTMLDivElement>('reviews-error');
  const reviewsList = $<HTMLUListElement>('reviews-list');
  const reviewsFilter = $<HTMLInputElement>('reviews-filter');
  const reviewsFacet = $<HTMLDivElement>('reviews-facet');
  const facetButtons = [...document.querySelectorAll<HTMLButtonElement>('#reviews-tools .facet')];
  const reviewsRefresh = $<HTMLButtonElement>('reviews-refresh');

  let isOpen = false;
  let review: ReviewRequest | null = null;
  let prompts: Prompt[] = [];
  let lastReviews: ReviewsState = { items: [], error: null, fetchedAt: null };
  let lastWorkspaces: readonly Workspace[] = [];
  // Deselected values are stored rather than selected ones, so new authors and repos show up.
  const hidden: Record<Facet, Set<string>> = { author: new Set(), repo: new Set() };
  let openFacet: Facet | null = null;
  // Shown straight away when a PR is reopened, while its fresh details load behind it.
  const detailsCache = new Map<string, PrDetails>();

  function show(target: ReviewRequest): void {
    review = target;
    isOpen = true;
    title.replaceChildren(el('code', ref(target), 'ref-chip'), el('span', target.title));
    filter.value = '';
    choose.hidden = false;
    editForm.hidden = true;
    section.hidden = false;
    const cached = detailsCache.get(target.url);
    detailsEl.replaceChildren(...(cached ? renderDetails(cached) : [el('div', 'Loading PR details…', 'loading')]));
    detailsEl.classList.toggle('refreshing', cached !== undefined);
    send({ type: 'prDetails', url: target.url });
    send({ type: 'listPrompts' });
    const current = here().workspace;
    hereLabel.textContent = current ? `Use this window (a tab group beside ${current.name})` : 'Use this window';
    void chrome.storage.local.get('useThisWindow').then(({ useThisWindow }) => {
      hereInput.checked = useThisWindow === true;
    });
    onToggle();
    filter.focus();
  }

  function close(): void {
    isOpen = false;
    review = null;
    section.hidden = true;
    onToggle();
  }

  function renderPrompts(): void {
    const query = filter.value.trim().toLowerCase();
    const groups = new Map<string, Prompt[]>();
    for (const prompt of prompts) {
      if (query && !`${prompt.section} ${prompt.text}`.toLowerCase().includes(query)) continue;
      groups.set(prompt.section, [...(groups.get(prompt.section) ?? []), prompt]);
    }
    promptsEl.replaceChildren(
      ...[...groups].map(([name, items]) => {
        const group = el('section', '', 'prompt-group');
        const heading = el('h3', name || 'Prompts');
        heading.append(el('span', String(items.length), 'count'));
        const grid = el('div', '', 'prompt-grid');
        grid.append(
          ...items.map((prompt) => {
            const button = el('button', '', 'prompt');
            button.type = 'button';
            button.title = prompt.text;
            button.append(...promptCard(prompt.text));
            button.addEventListener('click', () => edit(prompt));
            return button;
          }),
        );
        group.append(heading, grid);
        return group;
      }),
    );
  }

  function edit(prompt: Prompt): void {
    choose.hidden = true;
    editForm.hidden = false;
    if (!review) return;
    nameInput.value = ref(review);
    textInput.value = fillPrompt(prompt.text, { prUrl: review.url, ticket: review.ticket });
    textInput.focus();
  }

  filter.addEventListener('input', renderPrompts);

  $<HTMLButtonElement>('launch-close').addEventListener('click', close);

  githubButton.addEventListener('click', () => {
    if (review) void chrome.tabs.create({ url: review.url });
  });

  $<HTMLButtonElement>('launch-back').addEventListener('click', () => {
    editForm.hidden = true;
    choose.hidden = false;
    filter.focus();
  });

  editForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const prompt = textInput.value.trim();
    if (!review || !name || !prompt) return;
    const { windowId, workspace } = here();
    const useHere = hereInput.checked && windowId !== undefined;
    void chrome.storage.local.set({ useThisWindow: hereInput.checked });
    send({ type: 'create', name, windowId: useHere ? windowId : null, prompt, pr: review.url, ...(useHere && workspace ? { group: true } : {}) });
    // A new window or a tab group opens at the PR on its own; a window with no workspace needs a tab for it.
    if (useHere && !workspace) void chrome.tabs.create({ windowId, url: review.url });
    close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (openFacet) {
      openFacet = null;
      renderReviews(lastReviews, lastWorkspaces);
    } else if (isOpen) close();
  });

  reviewsRefresh.addEventListener('click', () => send({ type: 'refreshReviews' }));

  reviewsFilter.addEventListener('input', () => renderReviews(lastReviews, lastWorkspaces));
  reviewsFilter.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    reviewsFilter.value = '';
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
    void chrome.storage.local.set({ reviewsHidden: { author: [...hidden.author], repo: [...hidden.repo] } });
    renderReviews(lastReviews, lastWorkspaces);
  }

  $<HTMLButtonElement>('reviews-toggle').addEventListener('click', () => {
    const collapsed = reviewsSection.classList.toggle('collapsed');
    void chrome.storage.local.set({ reviewsCollapsed: collapsed });
  });

  void chrome.storage.local.get(['reviewsCollapsed', 'reviewsHidden']).then(({ reviewsCollapsed, reviewsHidden }) => {
    reviewsSection.classList.toggle('collapsed', reviewsCollapsed === true);
    const saved = reviewsHidden as Partial<Record<Facet, string[]>> | undefined;
    for (const facet of ['author', 'repo'] as const) for (const value of saved?.[facet] ?? []) hidden[facet].add(value);
    renderReviews(lastReviews, lastWorkspaces);
  });

  /** Updates the Authors and Repos buttons, and the checklist for whichever is open. */
  function renderFacets(items: readonly ReviewRequest[]): void {
    for (const button of facetButtons) {
      const facet = button.dataset.facet as Facet;
      const values = new Set(items.map((item) => item[facet]));
      const shown = [...values].filter((value) => !hidden[facet].has(value)).length;
      button.textContent = shown === values.size ? FACET_LABELS[facet] : `${FACET_LABELS[facet]} ${shown}/${values.size}`;
      button.classList.toggle('active', shown !== values.size);
      button.classList.toggle('open', facet === openFacet);
    }
    reviewsFacet.hidden = openFacet === null;
    if (!openFacet) return;
    const facet = openFacet;
    const counts = new Map<string, number>();
    for (const item of items) counts.set(item[facet], (counts.get(item[facet]) ?? 0) + 1);
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
    const query = reviewsFilter.value.trim().toLowerCase();
    const items = state.items.filter(
      (item) => !hidden.author.has(item.author) && !hidden.repo.has(item.repo) && (!query || matches(item, query)),
    );
    renderFacets(state.items);
    const count = items.length === state.items.length ? `${items.length}` : `${items.length} of ${state.items.length}`;
    reviewsTitle.textContent = `Review requests (${count})`;
    reviewsRefresh.title = state.fetchedAt
      ? `Refresh review requests (updated ${relative(state.fetchedAt)})`
      : 'Refresh review requests';
    reviewsError.hidden = state.error === null;
    reviewsError.textContent = state.error?.split('\n')[0] ?? '';
    reviewsError.title = state.error ?? '';
    reviewsList.replaceChildren(
      ...items.map((item) => {
        const existing = workspaces.find((ws) => ws.pr === item.url);
        const row = document.createElement('li');
        row.className = `review${item.url === review?.url ? ' selected' : ''}`;
        row.title = `${item.title}\n${item.repo} by ${item.author}${existing ? `\nWorkspace: ${existing.name}` : ''}`;

        const head = document.createElement('span');
        head.className = 'ref';
        head.append(el('code', ref(item)));
        if (item.isDraft) {
          const draft = document.createElement('span');
          draft.className = 'draft';
          draft.textContent = 'draft';
          head.append(draft);
        }
        if (existing) {
          const dot = document.createElement('span');
          dot.className = 'has-workspace';
          head.append(dot);
        }

        const itemTitle = document.createElement('span');
        itemTitle.className = 'title';
        itemTitle.textContent = item.title;

        const when = el('span', `${item.author} · ${relative(item.updatedAt)}`, 'when');
        row.append(head, itemTitle, when);
        row.addEventListener('click', () => {
          if (item.url === review?.url) close();
          else if (existing) openWorkspace(existing);
          else show(item);
        });
        return row;
      }),
    );
  }

  return {
    get isOpen() {
      return isOpen;
    },
    show,
    close,
    renderReviews,
    setPrompts(next, error) {
      prompts = next;
      errorEl.hidden = error === null;
      errorEl.textContent = error ? `Could not read prompts: ${error}` : '';
      renderPrompts();
    },
    setPrDetails(url, details, error) {
      if (details) detailsCache.set(url, details);
      if (url !== review?.url) return;
      detailsEl.classList.remove('refreshing');
      const cached = detailsCache.get(url);
      if (details) detailsEl.replaceChildren(...renderDetails(details));
      else if (cached) detailsEl.replaceChildren(...renderDetails(cached), el('div', `Could not refresh PR details: ${error}`, 'failing'));
      else detailsEl.replaceChildren(el('div', `Could not load PR details: ${error}`, 'failing'));
    },
  };
}
