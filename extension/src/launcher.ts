import { fillPrompt } from '../../shared/prompts';
import type { ControlToHelper, Prompt, ReviewRequest, ReviewsState, Workspace } from '../../shared/protocol';

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
  renderReviews(state: ReviewsState, workspaces: readonly Workspace[]): void;
  setPrompts(prompts: Prompt[], error: string | null): void;
}

const repoName = (review: ReviewRequest) => review.repo.split('/')[1] ?? review.repo;
const ref = (review: ReviewRequest) => `${repoName(review)}#${review.number}`;

export function createLauncher({ send, onToggle, openWorkspace }: LauncherOptions): Launcher {
  const section = $<HTMLElement>('launch');
  const choose = $<HTMLDivElement>('launch-choose');
  const title = $<HTMLHeadingElement>('launch-title');
  const filter = $<HTMLInputElement>('launch-filter');
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
    send({ type: 'listPrompts' });
    onToggle();
    filter.focus();
  }

  function close(): void {
    isOpen = false;
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

  section.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
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
        row.className = 'review';
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
        row.addEventListener('click', () => (existing ? openWorkspace(existing) : show(item)));
        return row;
      }),
    );
  }

  return {
    get isOpen() {
      return isOpen;
    },
    show,
    renderReviews,
    setPrompts(next, error) {
      prompts = next;
      errorEl.hidden = error === null;
      errorEl.textContent = error ? `Could not read prompts: ${error}` : '';
      renderPrompts();
    },
  };
}
