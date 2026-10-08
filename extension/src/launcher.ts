import { fillPrompt } from '../../shared/prompts';
import type { ControlToHelper, PrDetails, Prompt, ReviewRequest, ReviewsState, Workspace } from '../../shared/protocol';

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
  /** Opens the prompt picker, for a review request or for a prompt alone. */
  show(review: ReviewRequest | null): void;
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

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

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

const SORTS: Record<string, (a: ReviewRequest, b: ReviewRequest) => number> = {
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  oldest: (a, b) => a.updatedAt.localeCompare(b.updatedAt),
  repo: (a, b) => a.repo.localeCompare(b.repo) || a.number - b.number,
  author: (a, b) => a.author.localeCompare(b.author) || b.updatedAt.localeCompare(a.updatedAt),
};

/** Every word of the query must appear somewhere in the request. */
function matches(item: ReviewRequest, query: string): boolean {
  const haystack = `${ref(item)} ${item.repo} ${item.title} ${item.author} ${item.ticket ?? ''}${item.isDraft ? ' draft' : ''}`.toLowerCase();
  return query.split(/\s+/).every((word) => haystack.includes(word));
}

/** Splits a leading slash command off a prompt, so cards can set the command apart. */
function promptCard(text: string): Node[] {
  const match = text.match(/^(\/[\w:-]+)\s*(.*)$/s);
  if (!match) return [el('span', text, 'prompt-text')];
  const nodes: Node[] = [el('code', match[1], 'prompt-command')];
  if (match[2]) nodes.push(el('span', match[2].replace(/^-\s*/, ''), 'prompt-text'));
  return nodes;
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
  const reviewsSort = $<HTMLSelectElement>('reviews-sort');
  const reviewsRefresh = $<HTMLButtonElement>('reviews-refresh');

  let isOpen = false;
  let review: ReviewRequest | null = null;
  let prompts: Prompt[] = [];
  let lastReviews: ReviewsState = { items: [], error: null, fetchedAt: null };
  let lastWorkspaces: readonly Workspace[] = [];

  function show(target: ReviewRequest | null): void {
    review = target;
    isOpen = true;
    if (target) title.replaceChildren(el('code', ref(target), 'ref-chip'), el('span', target.title));
    else title.textContent = 'New workspace from a prompt';
    filter.value = '';
    choose.hidden = false;
    editForm.hidden = true;
    section.hidden = false;
    githubButton.hidden = target === null;
    detailsEl.hidden = target === null;
    if (target) {
      detailsEl.replaceChildren(el('div', 'Loading PR details…', 'loading'));
      send({ type: 'prDetails', url: target.url });
    }
    send({ type: 'listPrompts' });
    const current = here().workspace;
    hereLabel.textContent = current ? `Use this window (moves ${current.name} out)` : 'Use this window';
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
    nameInput.value = review ? ref(review) : '';
    textInput.value = fillPrompt(prompt.text, { prUrl: review?.url ?? null, ticket: review?.ticket ?? null });
    (review ? textInput : nameInput).focus();
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
    if (!name || !prompt) return;
    const { windowId } = here();
    const useHere = hereInput.checked && windowId !== undefined;
    void chrome.storage.local.set({ useThisWindow: hereInput.checked });
    send({ type: 'create', name, windowId: useHere ? windowId : null, prompt, ...(review ? { pr: review.url } : {}) });
    // A new window opens at the PR on its own; this one needs a tab for it.
    if (useHere && review) void chrome.tabs.create({ windowId, url: review.url });
    close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen) close();
  });

  reviewsRefresh.addEventListener('click', () => send({ type: 'refreshReviews' }));

  reviewsFilter.addEventListener('input', () => renderReviews(lastReviews, lastWorkspaces));
  reviewsFilter.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    reviewsFilter.value = '';
    renderReviews(lastReviews, lastWorkspaces);
  });

  reviewsSort.addEventListener('change', () => {
    void chrome.storage.local.set({ reviewsSort: reviewsSort.value });
    renderReviews(lastReviews, lastWorkspaces);
  });

  $<HTMLButtonElement>('reviews-toggle').addEventListener('click', () => {
    const collapsed = reviewsSection.classList.toggle('collapsed');
    void chrome.storage.local.set({ reviewsCollapsed: collapsed });
  });

  void chrome.storage.local.get(['reviewsCollapsed', 'reviewsSort']).then(({ reviewsCollapsed, reviewsSort: sort }) => {
    reviewsSection.classList.toggle('collapsed', reviewsCollapsed === true);
    if (typeof sort === 'string' && sort in SORTS) {
      reviewsSort.value = sort;
      renderReviews(lastReviews, lastWorkspaces);
    }
  });

  function renderReviews(state: ReviewsState, workspaces: readonly Workspace[]): void {
    lastReviews = state;
    lastWorkspaces = workspaces;
    const query = reviewsFilter.value.trim().toLowerCase();
    const items = state.items.filter((item) => !query || matches(item, query)).sort(SORTS[reviewsSort.value] ?? SORTS.updated);
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
      if (url !== review?.url) return;
      detailsEl.replaceChildren(...(details ? renderDetails(details) : [el('div', `Could not load PR details: ${error}`, 'failing')]));
    },
  };
}
