import { parseTemplates, removeTemplate, type Template, upsertTemplate } from '../../../shared/workspaces/templates';
import { $, el } from '../ui/dom';

/** What a template remembers of the form; its id and name come from the picker. */
export type TemplateFields = Omit<Template, 'id' | 'name'>;

export interface TemplatePickerOptions {
  /** Fills the form from a template picked from the list. */
  apply(template: Template): void;
  /** The form as it is now, for saving as a template. */
  current(): TemplateFields;
}

export interface TemplatePicker {
  /** The view opened: the list is read again, and a review (which starts from its PR) has no templates. */
  show(forReview: boolean): void;
  /** The team's templates from the helper, listed read-only under their own heading; `error` is why they could not be read. */
  setTeam(templates: Template[], error: string | null): void;
}

/**
 * The saved templates of the New workspace view: a list to pick from, a name box to save the form under, and a delete
 * button. Personal ones live in `chrome.storage.local`; a team template lives in its file, so it can be applied but
 * not deleted.
 */
export function createTemplatePicker({ apply, current }: TemplatePickerOptions): TemplatePicker {
  const box = $<HTMLDivElement>('create-templates');
  const select = $<HTMLSelectElement>('create-template');
  const deleteButton = $<HTMLButtonElement>('template-delete');
  const nameRow = $<HTMLDivElement>('template-name-row');
  const nameInput = $<HTMLInputElement>('template-name');

  let templates: Template[] = [];
  let team: Template[] = [];

  function render(selected = ''): void {
    const none = el('option', 'None');
    none.value = '';
    const option = (t: Template) => Object.assign(el('option', t.name), { value: t.id });
    const group = el('optgroup') as HTMLOptGroupElement;
    group.label = 'Team';
    group.append(...team.map(option));
    select.replaceChildren(none, ...templates.map(option), ...(team.length ? [group] : []));
    select.value = selected;
    // A team template lives in its file, not here, so there is nothing to delete.
    deleteButton.hidden = !selected || selected.startsWith('team:');
  }

  async function load(): Promise<void> {
    const { templates: stored } = await chrome.storage.local.get('templates');
    templates = parseTemplates(stored);
    render();
  }

  async function save(): Promise<void> {
    const name = nameInput.value.trim();
    if (!name) return;
    const saved = upsertTemplate(templates, { id: crypto.randomUUID(), name, ...current() });
    await chrome.storage.local.set({ templates: saved });
    templates = saved;
    nameRow.hidden = true;
    render(saved.find((t) => t.name.toLowerCase() === name.toLowerCase())?.id ?? '');
  }

  select.addEventListener('change', () => {
    const chosen = [...templates, ...team].find((t) => t.id === select.value);
    deleteButton.hidden = !chosen || chosen.id.startsWith('team:');
    if (chosen) apply(chosen);
  });

  $<HTMLButtonElement>('template-save').addEventListener('click', () => {
    nameRow.hidden = false;
    nameInput.value = templates.find((t) => t.id === select.value)?.name ?? '';
    nameInput.focus();
    nameInput.select();
  });
  $<HTMLButtonElement>('template-confirm').addEventListener('click', () => void save());
  nameInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      event.stopPropagation();
      nameRow.hidden = true;
    }
  });
  deleteButton.addEventListener('click', async () => {
    const remaining = removeTemplate(templates, select.value);
    await chrome.storage.local.set({ templates: remaining });
    templates = remaining;
    render();
  });

  return {
    show(forReview) {
      box.hidden = forReview;
      nameRow.hidden = true;
      void load();
    },
    setTeam(next, error) {
      team = next;
      box.title = error ? `Team templates: ${error}` : '';
      render(select.value);
    },
  };
}
