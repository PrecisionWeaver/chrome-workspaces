import { fillPrompt } from '../../shared/prompts';
import { MAX_TAB_URLS, MODEL_ALIASES } from '../../shared/protocol';
import { parseTabUrls } from '../../shared/tab-urls';
import type { ControlToHelper, PrDetails, Prompt, Repo, ReviewRequest, Workspace } from '../../shared/protocol';
import { el, promptCard } from './dom';
import { ref, renderDetails, repoName } from './pr-view';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface CreateViewOptions {
  send(message: ControlToHelper): boolean;
  /** Called when the view opens or closes, so the panel can swap it with the terminal. */
  onToggle(): void;
  /** The window this panel is in, and the workspace it holds, if any. */
  here(): { windowId: number | undefined; workspace: Workspace | undefined };
}

export interface CreateView {
  readonly isOpen: boolean;
  /** Opens the view blank, or for a review request: named for it, with its details, prompts filled in, and the PR as a tab. */
  show(review?: ReviewRequest): void;
  close(): void;
  /** The review request being created a workspace for, if any. */
  readonly review: ReviewRequest | null;
  setPrompts(prompts: Prompt[], error: string | null): void;
  setRepos(repos: Repo[]): void;
  setPrDetails(url: string, details: PrDetails | null, error: string | null): void;
}

/** Marks one button of a segmented control active and returns a getter for its value. */
function segmented(container: HTMLElement, onChange: () => void) {
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('button')];
  const select = (value: string) => {
    for (const button of buttons) button.classList.toggle('active', button.dataset.value === value);
  };
  for (const button of buttons) {
    button.addEventListener('click', () => {
      select(button.dataset.value ?? '');
      onChange();
    });
  }
  return { select, value: () => container.querySelector<HTMLButtonElement>('.active')?.dataset.value ?? '' };
}

export function createCreateView({ send, onToggle, here }: CreateViewOptions): CreateView {
  const section = $<HTMLElement>('create');
  const form = $<HTMLFormElement>('create-form');
  const nameInput = $<HTMLInputElement>('create-name');
  const repoSelect = $<HTMLSelectElement>('create-repo');
  const modelSelect = $<HTMLSelectElement>('create-model');
  const tabsInput = $<HTMLTextAreaElement>('create-tabs');
  const promptSection = $<HTMLDivElement>('create-prompt');
  const choose = $<HTMLDivElement>('create-choose');
  const filter = $<HTMLInputElement>('create-filter');
  const errorEl = $<HTMLDivElement>('create-error');
  const promptsEl = $<HTMLDivElement>('create-prompts');
  const chosen = $<HTMLDivElement>('create-chosen');
  const textInput = $<HTMLTextAreaElement>('create-text');
  const windowButtons = $<HTMLDivElement>('create-window');
  const title = $<HTMLHeadingElement>('create-title');
  const detailsEl = $<HTMLDivElement>('create-details');
  const githubButton = $<HTMLButtonElement>('create-github');
  const tabsLabel = $<HTMLSpanElement>('create-tabs-label');

  let isOpen = false;
  let prompts: Prompt[] = [];
  let repos: Repo[] = [];
  let review: ReviewRequest | null = null;
  // Shown straight away when a PR is reopened, while its fresh details load behind it.
  const detailsCache = new Map<string, PrDetails>();
  // Picked in an earlier session; applied once the repo list arrives.
  let savedRepo = '';

  const defaultModel = el('option', 'Default');
  defaultModel.value = '';
  modelSelect.replaceChildren(defaultModel, ...MODEL_ALIASES.map((alias) => Object.assign(el('option', alias), { value: alias })));

  const start = segmented($<HTMLDivElement>('create-start'), syncStart);
  const target = segmented(windowButtons, () => {});

  function syncStart(): void {
    const fromPrompt = start.value() === 'prompt';
    promptSection.hidden = !fromPrompt;
    if (fromPrompt && chosen.hidden) filter.focus();
  }

  function show(request: ReviewRequest | null = null): void {
    isOpen = true;
    review = request;
    nameInput.value = request ? ref(request) : '';
    filter.value = '';
    textInput.value = '';
    choose.hidden = false;
    chosen.hidden = true;
    start.select(request ? 'prompt' : 'blank');
    syncStart();
    section.hidden = false;
    githubButton.hidden = detailsEl.hidden = request === null;
    tabsLabel.textContent = request ? 'The PR opens first, then these' : 'optional, one URL per line';
    if (request) {
      title.replaceChildren(el('code', ref(request), 'ref-chip'), el('span', request.title));
      const cached = detailsCache.get(request.url);
      detailsEl.replaceChildren(...(cached ? renderDetails(cached) : [el('div', 'Loading PR details…', 'loading')]));
      detailsEl.classList.toggle('refreshing', cached !== undefined);
      send({ type: 'prDetails', url: request.url });
    } else {
      title.textContent = 'New workspace';
    }

    const { windowId, workspace } = here();
    const thisWindow = windowButtons.querySelector<HTMLButtonElement>('[data-value="here"]')!;
    thisWindow.disabled = windowId === undefined;
    thisWindow.title = workspace ? 'Joins this window as a tab group' : '';

    send({ type: 'listPrompts' });
    send({ type: 'listRepos' });
    void chrome.storage.local.get(['useThisWindow', 'newRepo', 'newModel', 'newTabs']).then(({ useThisWindow, newRepo, newModel, newTabs }) => {
      // A review starts with only its PR; the saved list is for workspaces made from scratch.
      tabsInput.value = !request && typeof newTabs === 'string' ? newTabs : '';
      target.select(useThisWindow === true && windowId !== undefined ? 'here' : 'new');
      modelSelect.value = typeof newModel === 'string' ? newModel : '';
      if (modelSelect.value !== newModel) modelSelect.value = '';
      savedRepo = typeof newRepo === 'string' ? newRepo : '';
      selectRepo();
    });
    onToggle();
    (request ? filter : nameInput).focus();
  }

  /** A review starts in the repo its PR belongs to, when that repo is listed; otherwise the last pick. */
  function selectRepo(): void {
    const own = review ? repos.find((repo) => repo.name === repoName(review!)) : undefined;
    repoSelect.value = own?.path ?? (review ? '' : savedRepo);
    if (repoSelect.value !== (own?.path ?? (review ? '' : savedRepo))) repoSelect.value = '';
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    review = null;
    section.hidden = true;
    onToggle();
  }

  function renderRepos(): void {
    const repeated = new Set(repos.map((r) => r.name).filter((name, i, all) => all.indexOf(name) !== i));
    const options = repos.map((repo) => {
      const option = el('option', repeated.has(repo.name) ? `${repo.name} (${repo.root})` : repo.name);
      option.value = repo.path;
      option.title = repo.path;
      return option;
    });
    const standard = el('option', 'Default directory');
    standard.value = '';
    const picked = repoSelect.value;
    repoSelect.replaceChildren(standard, ...options);
    repoSelect.value = picked;
    if (repoSelect.value !== picked) selectRepo();
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
            button.addEventListener('click', () => choosePrompt(prompt));
            return button;
          }),
        );
        group.append(heading, grid);
        return group;
      }),
    );
  }

  function choosePrompt(prompt: Prompt): void {
    choose.hidden = true;
    chosen.hidden = false;
    textInput.value = fillPrompt(prompt.text, { prUrl: review?.url ?? null, ticket: review?.ticket ?? null });
    textInput.focus();
  }

  filter.addEventListener('input', renderPrompts);

  $<HTMLButtonElement>('create-change').addEventListener('click', () => {
    chosen.hidden = true;
    choose.hidden = false;
    filter.focus();
  });

  $<HTMLButtonElement>('create-close').addEventListener('click', close);

  githubButton.addEventListener('click', () => {
    if (review) void chrome.tabs.create({ url: review.url });
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen) close();
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    const prompt = start.value() === 'prompt' ? textInput.value.trim() : '';
    if (start.value() === 'prompt' && !prompt) {
      filter.focus();
      return;
    }
    const typed = parseTabUrls(tabsInput.value);
    // The PR leads the tabs, so a new window, a tab group and an adopted window all open at it.
    const urls = review ? [...new Set([review.url, ...typed.urls])] : typed.urls;
    tabsInput.setCustomValidity(typed.invalid.length ? `Not a web address: ${typed.invalid[0]}` : urls.length > MAX_TAB_URLS ? `At most ${MAX_TAB_URLS} tabs` : '');
    if (!tabsInput.reportValidity()) return;
    const { windowId, workspace } = here();
    const useHere = target.value() === 'here' && windowId !== undefined;
    void chrome.storage.local.set({
      useThisWindow: target.value() === 'here',
      newModel: modelSelect.value,
      // A review's repo and tabs belong to that PR, not to the next workspace.
      ...(review ? {} : { newRepo: repoSelect.value, newTabs: tabsInput.value.trim() }),
    });
    send({
      type: 'create',
      name,
      windowId: useHere ? windowId : null,
      // Joining a window that already holds a workspace gives the new one a tab group beside it.
      ...(useHere && workspace ? { group: true } : {}),
      ...(urls.length ? { urls } : {}),
      ...(modelSelect.value ? { model: modelSelect.value } : {}),
      ...(repoSelect.value ? { cwd: repoSelect.value } : {}),
      ...(prompt ? { prompt } : {}),
      ...(review ? { pr: review.url } : {}),
    });
    // A window with no workspace is adopted as it is; one that holds a workspace gets the tabs in its new group instead.
    if (useHere && !workspace) for (const url of urls) void chrome.tabs.create({ windowId, url, active: false });
    close();
  });

  return {
    get isOpen() {
      return isOpen;
    },
    show: (request) => show(request ?? null),
    close,
    setPrompts(next, error) {
      prompts = next;
      errorEl.hidden = error === null;
      errorEl.textContent = error ? `Could not read prompts: ${error}` : '';
      renderPrompts();
    },
    setRepos(next) {
      repos = next;
      renderRepos();
    },
    get review() {
      return review;
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
