// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import type { ControlToHelper } from '../../../shared/protocol/protocol';
import type { ConfigEdit } from '../../../shared/protocol/system';
import { type ConfigEditor, createConfigEditor } from './settings-config-edit';

const edit: ConfigEdit = {
  values: { defaultCwd: '~/code', defaultModel: 'opus', claudeCommand: '', promptsFile: '' },
  promptsPath: '/Users/me/.chrome-workspaces/prompts.md',
  prompts: '**Review**\n- check it\n',
};

let body: HTMLElement;
let grid: HTMLElement;
let sent: ControlToHelper[];
let results: { ok: boolean; message: string }[];
let editor: ConfigEditor;

const form = () => body.querySelector('form')!;
const input = (label: string) =>
  [...body.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label))!.querySelector('input,textarea') as HTMLInputElement;
const submit = () => form().dispatchEvent(new Event('submit', { cancelable: true }));
const button = (label: string) => [...body.querySelectorAll('button')].find((b) => b.textContent?.startsWith(label))!;

beforeEach(() => {
  document.body.innerHTML = '<div id="b"><div id="g"></div></div>';
  body = document.getElementById('b')!;
  grid = document.getElementById('g')!;
  sent = [];
  results = [];
  editor = createConfigEditor({ host: body, cards: grid, send: (m) => (sent.push(m), true), showResult: (r) => void results.push(r) });
});

describe('the config editor', () => {
  it('is hidden until opened, then replaces the cards and asks the helper for the fields', () => {
    expect(form().hidden).toBe(true);
    editor.open('/Users/me/.chrome-workspaces/config.json');
    expect(form().hidden).toBe(false);
    expect(grid.hidden).toBe(true);
    expect(editor.isOpen).toBe(true);
    expect(sent).toEqual([{ type: 'getConfigEdit' }]);
    expect(form().textContent).toContain('Saved to /Users/me/.chrome-workspaces/config.json');
    expect(button('Save').disabled).toBe(true);
  });

  it('fills the fields and the note when the helper answers, and enables Save', () => {
    editor.open('/c.json');
    editor.setEdit({ type: 'configEdit', edit, error: null });
    expect(input('Default directory').value).toBe('~/code');
    expect(input('Default model').value).toBe('opus');
    expect(input('Prompts note').value).toBe('**Review**\n- check it\n');
    expect(form().textContent).toContain(edit.promptsPath);
    expect(button('Save').disabled).toBe(false);
  });

  it('says so when the config cannot be read, and keeps Save off', () => {
    editor.open('/c.json');
    editor.setEdit({ type: 'configEdit', edit: null, error: 'config.json is not valid JSON' });
    expect(form().textContent).toContain('Could not read the config: config.json is not valid JSON');
    expect(button('Save').disabled).toBe(true);
  });

  it('marks a note that does not exist yet', () => {
    editor.open('/c.json');
    editor.setEdit({ type: 'configEdit', edit: { ...edit, prompts: null }, error: null });
    expect(form().textContent).toContain('not created yet');
  });

  it('sends the fields, and the note only when it changed', () => {
    editor.open('/c.json');
    editor.setEdit({ type: 'configEdit', edit, error: null });
    sent.length = 0;
    input('Default model').value = 'sonnet';
    submit();
    expect(sent).toEqual([
      { type: 'saveConfigEdit', values: { defaultCwd: '~/code', defaultModel: 'sonnet', claudeCommand: '', promptsFile: '' }, prompts: null },
    ]);
    expect(button('Saving').disabled).toBe(true);
    editor.setSaved({ type: 'configSaved', ok: false, message: 'refused', edit: null });
    input('Prompts note').value = '**New**\n- one\n';
    sent.length = 0;
    submit();
    expect(sent[0]).toMatchObject({ type: 'saveConfigEdit', prompts: '**New**\n- one\n' });
  });

  it('ignores a second submit while one is waiting, and one before the fields have loaded', () => {
    editor.open('/c.json');
    submit();
    editor.setEdit({ type: 'configEdit', edit, error: null });
    sent.length = 0;
    submit();
    submit();
    expect(sent).toHaveLength(1);
  });

  it('closes on a successful save and reports it', () => {
    editor.open('/c.json');
    editor.setEdit({ type: 'configEdit', edit, error: null });
    submit();
    editor.setSaved({ type: 'configSaved', ok: true, message: 'Saved.', edit });
    expect(results).toEqual([{ ok: true, message: 'Saved.' }]);
    expect(editor.isOpen).toBe(false);
    expect(form().hidden).toBe(true);
    expect(grid.hidden).toBe(false);
  });

  it('stays open on a refused save so the values can be fixed', () => {
    editor.open('/c.json');
    editor.setEdit({ type: 'configEdit', edit, error: null });
    submit();
    editor.setSaved({ type: 'configSaved', ok: false, message: 'Default model "x" is not a model name.', edit: null });
    expect(results).toEqual([{ ok: false, message: 'Default model "x" is not a model name.' }]);
    expect(editor.isOpen).toBe(true);
    expect(button('Save').disabled).toBe(false);
    expect(input('Default directory').value).toBe('~/code');
  });

  it('Cancel closes without saving, and replies that arrive after it are ignored', () => {
    editor.open('/c.json');
    button('Cancel').click();
    expect(grid.hidden).toBe(false);
    sent.length = 0;
    editor.setEdit({ type: 'configEdit', edit, error: null });
    editor.setSaved({ type: 'configSaved', ok: true, message: 'Saved.', edit });
    expect(results).toEqual([]);
    expect(sent).toEqual([]);
  });
});
