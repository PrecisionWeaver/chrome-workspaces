import { fillPrompt } from '../../../shared/workspaces/prompts';
import { MAX_TAB_URLS, MODEL_ALIASES, WORKSPACE_COLORS } from '../../../shared/protocol/protocol';
import { parseTabUrls } from '../../../shared/workspaces/tab-urls';
import { isBranchName, slugBranch } from '../../../shared/workspaces/branch-name';
import { parseTemplates, removeTemplate, upsertTemplate, type Template } from '../../../shared/workspaces/templates';
import type { ControlToClient, ControlToHelper, PrDetails, Prompt, Repo, ReviewRequest, Workspace, WorkspaceColor } from '../../../shared/protocol/protocol';
import { $, el, icon, promptCard, wireBack } from '../ui/dom';
import { ref, renderDetails, renderThreads, repoName } from '../source-control/pr-view';
import { findTab, noteReviewTab, openInWorkspace } from '../background/tabs';

export interface CreateViewOptions {
  send(message: ControlToHelper): boolean;
  /** Called when the view opens or closes, so the panel can swap it with the terminal. */
  onToggle(): void;
  /** The window this panel is in, and the workspace it holds, if any. */
  here(): { windowId: number | undefined; workspace: Workspace | undefined };
  /** The Jira address of a ticket key, or null when no Jira site is configured. */
  ticketLink(ticket: string | null): string | null;
}

export interface CreateView {
  readonly isOpen: boolean;
  /** Opens the view blank, or for a review request: named for it, with its details, prompts filled in, and the PR as a tab. */
  show(review?: ReviewRequest): void;
  close(): void;
  /** The review request being created a workspace for, if any. */
  readonly review: ReviewRequest | null;
  setPrompts(prompts: Prompt[], error: string | null): void;
  /** The team's templates from the helper, listed read-only under their own heading. */
  setTemplates(templates: Template[], error: string | null): void;
  setRepos(repos: Repo[]): void;
  setPrDetails(url: string, details: PrDetails | null, error: string | null): void;
  setPrThreads(message: Extract<ControlToClient, { type: 'prThreads' }>): void;
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

export function createCreateView({ send, onToggle, here, ticketLink }: CreateViewOptions): CreateView {
  const section = $<HTMLElement>('create');
  const form = $<HTMLFormElement>('create-form');
  const nameInput = $<HTMLInputElement>('create-name');
  const repoSelect = $<HTMLSelectElement>('create-repo');
  const modelSelect = $<HTMLSelectElement>('create-model');
  const colorRow = $<HTMLDivElement>('create-color');
  const tabsInput = $<HTMLTextAreaElement>('create-tabs');
  const promptSection = $<HTMLDivElement>('create-prompt');
  const messageSection = $<HTMLDivElement>('create-message');
  const messageInput = $<HTMLTextAreaElement>('create-message-text');
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
  const ticketButton = $<HTMLButtonElement>('create-ticket');
  // Review comments sit last inside the details card, so every repaint of the card has to put them back.
  const threadsEl = el('div', '', 'create-threads');
  threadsEl.id = 'create-threads';
  const paintDetails = (...nodes: Node[]): void => detailsEl.replaceChildren(...nodes, threadsEl);
  const templateBox = $<HTMLDivElement>('create-templates');
  const templateSelect = $<HTMLSelectElement>('create-template');
  const templateDelete = $<HTMLButtonElement>('template-delete');
  const templateNameRow = $<HTMLDivElement>('template-name-row');
  const templateName = $<HTMLInputElement>('template-name');
  const worktreeBox = $<HTMLInputElement>('create-worktree');
  const branchInput = $<HTMLInputElement>('create-branch');
  // Whether the branch was typed since the view opened; until then it follows the name.
  let branchEdited = false;
  function syncBranch(): void {
    branchInput.hidden = !worktreeBox.checked;
    if (!branchEdited) branchInput.value = slugBranch(nameInput.value);
  }
  worktreeBox.addEventListener('change', syncBranch);
  nameInput.addEventListener('input', syncBranch);
  branchInput.addEventListener('input', () => {
    branchEdited = true;
    branchInput.setCustomValidity('');
  });

  let isOpen = false;
  let prompts: Prompt[] = [];
  // The section whose prompts show when not filtering; kept between openings, so the usual one stays picked.
  let promptTab: string | null = null;
  let repos: Repo[] = [];
  let review: ReviewRequest | null = null;
  // Shown straight away when a PR is reopened, while its fresh details load behind it.
  const detailsCache = new Map<string, PrDetails>();
  // Picked in an earlier session; applied once the repo list arrives.
  let savedRepo = '';
  // Whether the repo was picked by hand (or by a template) since the view opened; if not, the list arriving picks one.
  let repoPicked = false;

  const defaultModel = el('option', 'Default');
  defaultModel.value = '';
  modelSelect.replaceChildren(defaultModel, ...MODEL_ALIASES.map((alias) => Object.assign(el('option', alias), { value: alias })));

  // Not remembered between workspaces: a color says which one this is.
  let color: WorkspaceColor | null = null;
  const swatches = new Map<WorkspaceColor | null, HTMLButtonElement>();
  for (const option of [null, ...WORKSPACE_COLORS]) {
    const swatch = el('button', option ? '' : '×');
    swatch.type = 'button';
    swatch.className = 'swatch';
    swatch.title = option ?? 'No color';
    if (option) swatch.dataset.group = option;
    swatch.addEventListener('click', () => pickColor(option));
    swatches.set(option, swatch);
    colorRow.append(swatch);
  }
  function pickColor(next: WorkspaceColor | null): void {
    color = next;
    for (const [option, swatch] of swatches) swatch.classList.toggle('selected', option === color);
  }
  pickColor(null);

  const start = segmented($<HTMLDivElement>('create-start'), syncStart);
  const target = segmented(windowButtons, () => {});

  function syncStart(): void {
    const mode = start.value();
    promptSection.hidden = mode !== 'prompt';
    messageSection.hidden = mode !== 'text';
    if (mode === 'prompt' && chosen.hidden) filter.focus();
    if (mode === 'text') messageInput.focus();
  }

  // ---- templates ----

  let templates: Template[] = [];
  let teamTemplates: Template[] = [];

  async function loadTemplates(): Promise<void> {
    const { templates: stored } = await chrome.storage.local.get('templates');
    templates = parseTemplates(stored);
    renderTemplates();
  }

  function renderTemplates(selected = ''): void {
    const none = el('option', 'None');
    none.value = '';
    const option = (t: Template) => Object.assign(el('option', t.name), { value: t.id });
    const team = el('optgroup') as HTMLOptGroupElement;
    team.label = 'Team';
    team.append(...teamTemplates.map(option));
    templateSelect.replaceChildren(none, ...templates.map(option), ...(teamTemplates.length ? [team] : []));
    templateSelect.value = selected;
    // A team template lives in its file, not here, so there is nothing to delete.
    templateDelete.hidden = !selected || selected.startsWith('team:');
  }

  /** Fills the form from a template; the name is left alone, since each workspace has its own. */
  function applyTemplate(template: Template): void {
    repoSelect.value = template.repo;
    if (repoSelect.value !== template.repo) repoSelect.value = '';
    repoPicked = true;
    modelSelect.value = template.model;
    if (modelSelect.value !== template.model) modelSelect.value = '';
    tabsInput.value = template.tabs;
    tabsInput.setCustomValidity('');
    messageInput.value = template.message;
    start.select(template.message ? 'text' : 'blank');
    syncStart();
    const { windowId } = here();
    target.select(template.window === 'here' && windowId !== undefined ? 'here' : 'new');
    worktreeBox.checked = template.worktree;
    syncBranch();
  }

  templateSelect.addEventListener('change', () => {
    const chosen = [...templates, ...teamTemplates].find((t) => t.id === templateSelect.value);
    templateDelete.hidden = !chosen || chosen.id.startsWith('team:');
    if (chosen) applyTemplate(chosen);
  });

  $<HTMLButtonElement>('template-save').addEventListener('click', () => {
    templateNameRow.hidden = false;
    templateName.value = templates.find((t) => t.id === templateSelect.value)?.name ?? '';
    templateName.focus();
    templateName.select();
  });

  async function saveTemplate(): Promise<void> {
    const name = templateName.value.trim();
    if (!name) return;
    // The first message is whichever is showing: typed text, or the prompt that was picked and edited.
    const mode = start.value();
    const message = mode === 'text' ? messageInput.value.trim() : mode === 'prompt' ? textInput.value.trim() : '';
    const saved = upsertTemplate(templates, {
      id: crypto.randomUUID(),
      name,
      repo: repoSelect.value,
      model: modelSelect.value,
      tabs: tabsInput.value.trim(),
      message,
      window: target.value() === 'here' ? 'here' : 'new',
      worktree: worktreeBox.checked,
    });
    await chrome.storage.local.set({ templates: saved });
    templates = saved;
    templateNameRow.hidden = true;
    renderTemplates(saved.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id ?? '');
  }

  $<HTMLButtonElement>('template-confirm').addEventListener('click', () => void saveTemplate());
  templateName.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveTemplate();
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      templateNameRow.hidden = true;
    }
  });
  templateDelete.addEventListener('click', async () => {
    const remaining = removeTemplate(templates, templateSelect.value);
    await chrome.storage.local.set({ templates: remaining });
    templates = remaining;
    renderTemplates();
  });

  function show(request: ReviewRequest | null = null): void {
    isOpen = true;
    review = request;
    repoPicked = false;
    pickColor(null);
    // A review starts from its PR, so templates are for workspaces made from scratch.
    templateBox.hidden = request !== null;
    templateNameRow.hidden = true;
    void loadTemplates();
    nameInput.value = request ? ref(request) : '';
    // A review's worktree is for the PR's branch, which git checks out from the remote.
    branchEdited = Boolean(request?.branch);
    branchInput.value = request?.branch ?? '';
    branchInput.setCustomValidity('');
    filter.value = '';
    textInput.value = '';
    messageInput.value = '';
    choose.hidden = false;
    chosen.hidden = true;
    start.select('prompt');
    syncStart();
    section.hidden = false;
    // Opening for another review, or from scratch, starts at the top rather than wherever the last one was scrolled.
    section.scrollTop = 0;
    githubButton.hidden = detailsEl.hidden = request === null;
    const ticket = ticketLink(request?.ticket ?? null);
    ticketButton.hidden = ticket === null;
    ticketButton.replaceChildren(...(request?.ticket ? [icon('ticket'), `${request.ticket} in Jira`] : []));
    ticketButton.dataset.url = ticket ?? '';
    threadsEl.replaceChildren();
    if (request) {
      title.replaceChildren(el('code', ref(request), 'ref-chip'), el('span', request.title));
      const cached = detailsCache.get(request.url);
      paintDetails(...(cached ? renderDetails(cached) : [el('div', 'Loading PR details…', 'loading')]));
      detailsEl.classList.toggle('refreshing', cached !== undefined);
      send({ type: 'prDetails', url: request.url });
      send({ type: 'prThreads', url: request.url });
      threadsEl.replaceChildren(el('div', 'Loading review comments…', 'threads-empty'));
    } else {
      title.textContent = 'New workspace';
    }

    const { windowId, workspace } = here();
    const thisWindow = windowButtons.querySelector<HTMLButtonElement>('[data-value="here"]')!;
    thisWindow.disabled = windowId === undefined;
    thisWindow.title = workspace ? 'Joins this window as a tab group' : '';

    send({ type: 'listPrompts' });
    send({ type: 'listTemplates' });
    send({ type: 'listRepos' });
    // Tabs belong to one ticket, so unlike the repo and model they start empty every time, bar a review's PR.
    tabsInput.value = request?.url ?? '';
    tabsInput.setCustomValidity('');
    void chrome.storage.local.get(['useThisWindow', 'newRepo', 'newModel', 'newWorktree']).then(({ useThisWindow, newRepo, newModel, newWorktree }) => {
      target.select(useThisWindow === true && windowId !== undefined ? 'here' : 'new');
      worktreeBox.checked = newWorktree === true;
      syncBranch();
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
    // An empty select reads '' before and after, so only a pick made by hand is kept over the default.
    if (!repoPicked || repoSelect.value !== picked) selectRepo();
  }

  function promptGrid(items: Prompt[]): HTMLElement {
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
    return grid;
  }

  function renderPrompts(): void {
    const query = filter.value.trim().toLowerCase();
    const groups = new Map<string, Prompt[]>();
    for (const prompt of prompts) {
      if (query && !`${prompt.section} ${prompt.text}`.toLowerCase().includes(query)) continue;
      groups.set(prompt.section, [...(groups.get(prompt.section) ?? []), prompt]);
    }
    const label = (name: string) => name || 'Prompts';
    // A filter searches every section at once, so it lists its matches under their headings rather than behind tabs.
    if (!query && groups.size > 1) {
      if (promptTab === null || !groups.has(promptTab)) promptTab = [...groups.keys()][0]!;
      const tabs = el('div', '', 'segmented prompt-tabs');
      tabs.append(
        ...[...groups].map(([name, items]) => {
          const tab = el('button', label(name));
          tab.type = 'button';
          tab.classList.toggle('active', name === promptTab);
          tab.append(el('span', String(items.length), 'count'));
          tab.addEventListener('click', () => {
            promptTab = name;
            renderPrompts();
          });
          return tab;
        }),
      );
      // The row is rebuilt on every click, so it keeps the place it was scrolled to.
      const scrolled = promptsEl.querySelector('.prompt-tabs')?.scrollLeft ?? 0;
      promptsEl.replaceChildren(tabs, promptGrid(groups.get(promptTab) ?? []));
      tabs.scrollLeft = scrolled;
      return;
    }
    promptsEl.replaceChildren(
      ...[...groups].map(([name, items]) => {
        const group = el('section', '', 'prompt-group');
        const heading = el('h3', label(name));
        heading.append(el('span', String(items.length), 'count'));
        group.append(heading, promptGrid(items));
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
  // A message set on a failed submit would otherwise outlive the text that caused it.
  tabsInput.addEventListener('input', () => tabsInput.setCustomValidity(''));
  repoSelect.addEventListener('change', () => (repoPicked = true));

  $<HTMLButtonElement>('create-change').addEventListener('click', () => {
    chosen.hidden = true;
    choose.hidden = false;
    filter.focus();
  });

  wireBack('create-close', close, () => isOpen);

  ticketButton.addEventListener('click', () => {
    if (ticketButton.dataset.url) void chrome.tabs.create({ url: ticketButton.dataset.url });
  });

  githubButton.addEventListener('click', () => {
    if (!review) return;
    const { url } = review;
    void openInWorkspace(here().workspace, here().windowId, url).then((tabId) => {
      if (tabId !== undefined) void noteReviewTab(url, tabId);
    });
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    if (!name) return;
    const mode = start.value();
    // Typed text gets the same PR-URL and ticket fill-in as a saved prompt, so a review can refer to its PR.
    const message = fillPrompt(messageInput.value.trim(), { prUrl: review?.url ?? null, ticket: review?.ticket ?? null });
    const prompt = mode === 'prompt' ? textInput.value.trim() : mode === 'text' ? message : '';
    // From prompt is the default, so leaving it unpicked starts the workspace blank; typed text must be there.
    if (mode === 'text' && !prompt) {
      messageInput.focus();
      return;
    }
    const typed = parseTabUrls(tabsInput.value);
    const urls = typed.urls;
    tabsInput.setCustomValidity(
      typed.invalid.length ? `Not a web address: ${typed.invalid[0]}` : urls.length > MAX_TAB_URLS ? `At most ${MAX_TAB_URLS} tabs` : '',
    );
    if (!tabsInput.reportValidity()) return;
    let worktree: string | undefined;
    if (worktreeBox.checked) {
      worktree = branchInput.value.trim() || slugBranch(name);
      branchInput.setCustomValidity(isBranchName(worktree) ? '' : 'Not a branch name git accepts');
      if (!branchInput.reportValidity()) return;
    }
    const { windowId, workspace } = here();
    const useHere = target.value() === 'here' && windowId !== undefined;
    void chrome.storage.local.set({
      useThisWindow: target.value() === 'here',
      newModel: modelSelect.value,
      newWorktree: worktreeBox.checked,
      // A review's repo and tabs belong to that PR, not to the next workspace.
      ...(review ? {} : { newRepo: repoSelect.value }),
    });
    send({
      type: 'create',
      name,
      windowId: useHere ? windowId : null,
      // Joining a window that already holds a workspace gives the new one a tab group beside it.
      ...(useHere && workspace ? { group: true } : {}),
      ...(urls.length ? { urls } : {}),
      ...(modelSelect.value ? { model: modelSelect.value } : {}),
      ...(color ? { color } : {}),
      ...(repoSelect.value ? { cwd: repoSelect.value } : {}),
      ...(worktree ? { worktree } : {}),
      ...(prompt ? { prompt } : {}),
      ...(review ? { pr: review.url } : {}),
    });
    // A window with no workspace is adopted as it is; one that holds a workspace gets the tabs in its new group instead.
    if (useHere && !workspace) {
      void (async () => {
        for (const url of urls) if (!(await findTab(windowId!, null, url))) await chrome.tabs.create({ windowId, url, active: false });
      })();
    }
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
    setTemplates(next, error) {
      teamTemplates = next;
      templateBox.title = error ? `Team templates: ${error}` : '';
      renderTemplates(templateSelect.value);
    },
    setRepos(next) {
      repos = next;
      renderRepos();
    },
    setPrThreads(message) {
      if (message.url !== review?.url) return;
      if (message.error) threadsEl.replaceChildren(el('div', `Could not load review comments: ${message.error}`, 'threads-empty'));
      else threadsEl.replaceChildren(...renderThreads(message.threads, message.total));
    },
    get review() {
      return review;
    },
    setPrDetails(url, details, error) {
      if (details) detailsCache.set(url, details);
      if (url !== review?.url) return;
      detailsEl.classList.remove('refreshing');
      const cached = detailsCache.get(url);
      if (details) paintDetails(...renderDetails(details));
      else if (cached) paintDetails(...renderDetails(cached), el('div', `Could not refresh PR details: ${error}`, 'failing'));
      else paintDetails(el('div', `Could not load PR details: ${error}`, 'failing'));
    },
  };
}
