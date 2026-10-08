import { fillPrompt } from '../../shared/prompts';
import { MODEL_ALIASES } from '../../shared/protocol';
import type { ControlToHelper, Prompt, Repo, Workspace } from '../../shared/protocol';
import { el, promptCard } from './dom';

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
  show(): void;
  close(): void;
  setPrompts(prompts: Prompt[], error: string | null): void;
  setRepos(repos: Repo[]): void;
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
  const promptSection = $<HTMLDivElement>('create-prompt');
  const choose = $<HTMLDivElement>('create-choose');
  const filter = $<HTMLInputElement>('create-filter');
  const errorEl = $<HTMLDivElement>('create-error');
  const promptsEl = $<HTMLDivElement>('create-prompts');
  const chosen = $<HTMLDivElement>('create-chosen');
  const textInput = $<HTMLTextAreaElement>('create-text');
  const windowButtons = $<HTMLDivElement>('create-window');

  let isOpen = false;
  let prompts: Prompt[] = [];
  let repos: Repo[] = [];
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

  function show(): void {
    isOpen = true;
    nameInput.value = '';
    filter.value = '';
    textInput.value = '';
    choose.hidden = false;
    chosen.hidden = true;
    start.select('blank');
    syncStart();
    section.hidden = false;

    const { windowId, workspace } = here();
    const thisWindow = windowButtons.querySelector<HTMLButtonElement>('[data-value="here"]')!;
    thisWindow.disabled = windowId === undefined;
    thisWindow.title = workspace ? 'Joins this window as a tab group' : '';

    send({ type: 'listPrompts' });
    send({ type: 'listRepos' });
    void chrome.storage.local.get(['useThisWindow', 'newRepo', 'newModel']).then(({ useThisWindow, newRepo, newModel }) => {
      target.select(useThisWindow === true && windowId !== undefined ? 'here' : 'new');
      modelSelect.value = typeof newModel === 'string' ? newModel : '';
      if (modelSelect.value !== newModel) modelSelect.value = '';
      savedRepo = typeof newRepo === 'string' ? newRepo : '';
      repoSelect.value = savedRepo;
      if (repoSelect.value !== savedRepo) repoSelect.value = '';
    });
    onToggle();
    nameInput.focus();
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    section.hidden = true;
    onToggle();
  }

  function renderRepos(): void {
    const current = repoSelect.value || savedRepo;
    const repeated = new Set(repos.map((r) => r.name).filter((name, i, all) => all.indexOf(name) !== i));
    const options = repos.map((repo) => {
      const option = el('option', repeated.has(repo.name) ? `${repo.name} (${repo.root})` : repo.name);
      option.value = repo.path;
      option.title = repo.path;
      return option;
    });
    const standard = el('option', 'Default directory');
    standard.value = '';
    repoSelect.replaceChildren(standard, ...options);
    repoSelect.value = current;
    if (repoSelect.value !== current) repoSelect.value = '';
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
    textInput.value = fillPrompt(prompt.text, { prUrl: null, ticket: null });
    textInput.focus();
  }

  filter.addEventListener('input', renderPrompts);

  $<HTMLButtonElement>('create-change').addEventListener('click', () => {
    chosen.hidden = true;
    choose.hidden = false;
    filter.focus();
  });

  $<HTMLButtonElement>('create-close').addEventListener('click', close);

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
    const { windowId } = here();
    const useHere = target.value() === 'here' && windowId !== undefined;
    void chrome.storage.local.set({ useThisWindow: target.value() === 'here', newRepo: repoSelect.value, newModel: modelSelect.value });
    send({
      type: 'create',
      name,
      windowId: useHere ? windowId : null,
      // Joining a window that already holds a workspace gives the new one a tab group beside it.
      ...(useHere && here().workspace ? { group: true } : {}),
      ...(modelSelect.value ? { model: modelSelect.value } : {}),
      ...(repoSelect.value ? { cwd: repoSelect.value } : {}),
      ...(prompt ? { prompt } : {}),
    });
    close();
  });

  return {
    get isOpen() {
      return isOpen;
    },
    show,
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
  };
}
