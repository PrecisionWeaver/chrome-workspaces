import { fillPrompt } from '../../shared/prompts';
import type { ControlToHelper, PrDetails, Prompt, ReviewRequest, ReviewsState, Workspace } from '../../shared/protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface LauncherOptions {
  send(message: ControlToHelper): boolean;
  /** Called when the launch view opens or closes, so the panel can swap it with the terminal. */
  onToggle(): void;
  openWorkspace(workspace: Workspace): void;
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

function renderDetails(pr: PrDetails): Node[] {
  const meta = el('div', `${pr.author} · ${pr.head} → ${pr.base} · +${pr.additions} −${pr.deletions} · ${pr.changedFiles} files`, 'meta');

  const tags = el('div', '', 'tags');
  const [label, tone] = DECISIONS[pr.reviewDecision ?? ''] ?? ['No review required', ''];
  tags.append(el('span', label, `tag ${tone}`));
  if (pr.isDraft) tags.append(el('span', 'Draft', 'tag'));
  if (pr.mergeable === 'CONFLICTING') tags.append(el('span', 'Merge conflicts', 'tag bad'));
  const { passed, failed, pending, failing } = pr.checks;
  if (failed) tags.append(el('span', `✗ ${failed} failing`, 'tag bad'));
  if (pending) tags.append(el('span', `● ${pending} pending`, 'tag wait'));
  if (passed) tags.append(el('span', `✓ ${passed} passed`, 'tag good'));

  const nodes: Node[] = [meta, tags];
  if (failing.length) nodes.push(el('div', `Failing: ${failing.join(', ')}`, 'bad'));

  nodes.push(el('h3', 'Reviews'));
  const reviews = el('ul');
  if (pr.reviews.length === 0) reviews.append(el('li', 'None yet', 'meta'));
  for (const review of pr.reviews) {
    const [stateLabel, stateTone] = REVIEW_STATES[review.state] ?? [review.state.toLowerCase(), ''];
    const item = el('li', `${review.login} `);
    item.append(el('span', stateLabel, stateTone));
    if (review.at) item.title = new Date(review.at).toLocaleString();
    reviews.append(item);
  }
  nodes.push(reviews);

  if (pr.requested.length) {
    nodes.push(el('h3', 'Waiting on'));
    nodes.push(el('div', pr.requested.join(', '), 'meta'));
  }
  nodes.push(el('div', `Opened ${new Date(pr.createdAt).toLocaleString()} · updated ${new Date(pr.updatedAt).toLocaleString()}`, 'meta'));
  return nodes;
}

export function createLauncher({ send, onToggle, openWorkspace }: LauncherOptions): Launcher {
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
  const reviewsSection = $<HTMLElement>('reviews');
  const reviewsTitle = $<HTMLSpanElement>('reviews-title');
  const reviewsError = $<HTMLDivElement>('reviews-error');
  const reviewsList = $<HTMLUListElement>('reviews-list');

  let isOpen = false;
  let review: ReviewRequest | null = null;
  let prompts: Prompt[] = [];

  function show(target: ReviewRequest | null): void {
    review = target;
    isOpen = true;
    title.textContent = target ? `${ref(target)}: ${target.title}` : 'New workspace from a prompt';
    filter.value = '';
    choose.hidden = false;
    editForm.hidden = true;
    section.hidden = false;
    githubButton.hidden = target === null;
    detailsEl.hidden = target === null;
    if (target) {
      detailsEl.replaceChildren(el('div', 'Loading PR details…', 'meta'));
      send({ type: 'prDetails', url: target.url });
    }
    send({ type: 'listPrompts' });
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
        const group = document.createElement('div');
        group.className = 'prompt-group';
        const heading = document.createElement('h3');
        heading.textContent = name || 'Prompts';
        group.append(
          heading,
          ...items.map((prompt) => {
            const button = document.createElement('button');
            button.className = 'prompt';
            button.textContent = prompt.text;
            button.addEventListener('click', () => edit(prompt));
            return button;
          }),
        );
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
    send({ type: 'create', name, windowId: null, prompt, ...(review ? { pr: review.url } : {}) });
    close();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen) close();
  });

  $<HTMLButtonElement>('reviews-refresh').addEventListener('click', () => send({ type: 'refreshReviews' }));

  $<HTMLButtonElement>('reviews-toggle').addEventListener('click', () => {
    const collapsed = reviewsSection.classList.toggle('collapsed');
    void chrome.storage.local.set({ reviewsCollapsed: collapsed });
  });

  void chrome.storage.local.get('reviewsCollapsed').then(({ reviewsCollapsed }) => {
    reviewsSection.classList.toggle('collapsed', reviewsCollapsed === true);
  });

  function renderReviews(state: ReviewsState, workspaces: readonly Workspace[]): void {
    reviewsTitle.textContent = `Review requests (${state.items.length})`;
    reviewsError.hidden = state.error === null;
    reviewsError.textContent = state.error?.split('\n')[0] ?? '';
    reviewsError.title = state.error ?? '';
    reviewsList.replaceChildren(
      ...state.items.map((item) => {
        const existing = workspaces.find((ws) => ws.pr === item.url);
        const row = document.createElement('li');
        row.className = `review${item.url === review?.url ? ' selected' : ''}`;
        row.title = `${item.title}\n${item.repo} by ${item.author}${existing ? `\nWorkspace: ${existing.name}` : ''}`;

        const head = document.createElement('span');
        head.className = 'ref';
        head.append(ref(item));
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

        row.append(head, itemTitle);
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
      detailsEl.replaceChildren(...(details ? renderDetails(details) : [el('div', `Could not load PR details: ${error}`, 'bad')]));
    },
  };
}
