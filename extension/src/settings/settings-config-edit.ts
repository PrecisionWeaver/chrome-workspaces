import type { ControlToClient, ControlToHelper } from '../../../shared/protocol/protocol';
import type { ConfigEdit, ConfigEditValues } from '../../../shared/protocol/system';
import { el } from '../ui/dom';

/** The editor Settings opens for the few config fields that can change while the helper runs, and the prompts note they point at. */

export interface ConfigEditorOptions {
  /** Where the editor goes: beside the cards, which are hidden while it is open. */
  host: HTMLElement;
  cards: HTMLElement;
  send(message: ControlToHelper): boolean;
  showResult(result: { ok: boolean; message: string }): void;
}

export interface ConfigEditor {
  readonly isOpen: boolean;
  /** Shows the editor and asks the helper for the fields. */
  open(configPath: string): void;
  close(): void;
  setEdit(message: Extract<ControlToClient, { type: 'configEdit' }>): void;
  setSaved(message: Extract<ControlToClient, { type: 'configSaved' }>): void;
}

const FIELDS: { key: keyof ConfigEditValues; label: string; hint: string; placeholder: string }[] = [
  { key: 'defaultCwd', label: 'Default directory', hint: 'Where a workspace starts when no repo is picked, e.g. ~/code.', placeholder: 'your home folder' },
  { key: 'defaultModel', label: 'Default model', hint: 'claude --model for workspaces that pick none, e.g. opus.', placeholder: "claude's own" },
  { key: 'claudeCommand', label: 'Command', hint: 'A bare command name that starts claude, e.g. a wrapper called hr.', placeholder: 'claude' },
  { key: 'promptsFile', label: 'Prompts file', hint: 'A markdown note of reusable prompts.', placeholder: '~/.chrome-workspaces/prompts.md' },
];

export function createConfigEditor({ host, cards, send, showResult }: ConfigEditorOptions): ConfigEditor {
  const form = el('form', '', 'config-editor');
  form.hidden = true;
  form.noValidate = true;
  const note = el('p', '', 'settings-note');
  const status = el('p', 'Loading…', 'settings-note');
  const inputs = new Map<keyof ConfigEditValues, HTMLInputElement>();
  const fields = el('div', '', 'config-fields');
  for (const { key, label, hint, placeholder } of FIELDS) {
    const input = el('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    inputs.set(key, input);
    const wrap = el('label', '', 'config-field');
    wrap.append(el('span', label, 'config-label'), input, el('span', hint, 'config-hint'));
    fields.append(wrap);
  }
  const promptsLabel = el('span', 'Prompts note', 'config-label');
  const promptsHint = el('span', 'A **Heading** line starts a section; each "- " bullet under it is one prompt.', 'config-hint');
  const prompts = el('textarea', '', 'config-prompts');
  prompts.rows = 14;
  prompts.spellcheck = false;
  const promptsWrap = el('label', '', 'config-field');
  promptsWrap.append(promptsLabel, prompts, promptsHint);
  const save = el('button', 'Save', 'settings-btn');
  save.type = 'submit';
  const cancel = el('button', 'Cancel', 'settings-btn');
  cancel.type = 'button';
  const buttons = el('div', '', 'settings-actions');
  buttons.append(save, cancel);
  form.append(el('h3', 'Edit configuration'), note, status, fields, promptsWrap, buttons);
  host.append(form);

  let isOpen = false;
  let loaded: ConfigEdit | null = null;
  let saving = false;

  const sync = () => {
    const ready = loaded !== null && !saving;
    save.disabled = !ready;
    save.textContent = saving ? 'Saving…' : 'Save';
    for (const input of inputs.values()) input.disabled = !ready;
    prompts.disabled = !ready;
  };

  function fill(edit: ConfigEdit): void {
    loaded = edit;
    for (const [key, input] of inputs) input.value = edit.values[key];
    prompts.value = edit.prompts ?? '';
    promptsLabel.textContent = `Prompts note (${edit.promptsPath})${edit.prompts === null ? ' — not created yet' : ''}`;
    status.hidden = true;
    sync();
  }

  function close(): void {
    isOpen = false;
    saving = false;
    loaded = null;
    form.hidden = true;
    cards.hidden = false;
  }

  cancel.addEventListener('click', close);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!loaded || saving) return;
    const values = Object.fromEntries([...inputs].map(([key, input]) => [key, input.value])) as unknown as ConfigEditValues;
    // The note is only sent when it changed, so saving the fields never rewrites a file that was edited elsewhere.
    const changed = prompts.value !== (loaded.prompts ?? '');
    saving = true;
    sync();
    send({ type: 'saveConfigEdit', values, prompts: changed ? prompts.value : null });
  });

  return {
    get isOpen() {
      return isOpen;
    },
    open(configPath) {
      isOpen = true;
      loaded = null;
      note.textContent = `Saved to ${configPath}. New workspaces use the changes at once; running terminals keep what they started with. Repo folders, pricing and the other entries are edited in the file.`;
      status.textContent = 'Loading…';
      status.hidden = false;
      for (const input of inputs.values()) input.value = '';
      prompts.value = '';
      cards.hidden = true;
      form.hidden = false;
      sync();
      send({ type: 'getConfigEdit' });
    },
    close,
    setEdit(message) {
      if (!isOpen) return;
      if (message.edit) fill(message.edit);
      else status.textContent = `Could not read the config: ${message.error ?? 'unknown error'}`;
    },
    setSaved(message) {
      if (!isOpen) return;
      saving = false;
      showResult({ ok: message.ok, message: message.message });
      if (message.ok) close();
      else sync();
    },
  };
}
