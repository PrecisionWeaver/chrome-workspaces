// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Template } from '../../../shared/workspaces/templates';
import { flush } from '../../testing/flush';
import { installChrome } from '../../testing/chrome-mock';
import { loadPanelHtml } from '../../testing/fixtures';
import { createTemplatePicker, type TemplateFields, type TemplatePicker } from './template-picker';

const fields: TemplateFields = { repo: '/Users/me/app', model: 'haiku', tabs: 'https://example.com', message: 'hello', window: 'new', worktree: true };
const template = (id: string, name: string): Template => ({ id, name, ...fields });

let fake: ReturnType<typeof installChrome>;
let picker: TemplatePicker;
let applied: Template[];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const options = () => [...$<HTMLSelectElement>('create-template').options].map((o) => o.textContent);
const pick = (id: string) => {
  const select = $<HTMLSelectElement>('create-template');
  select.value = id;
  select.dispatchEvent(new Event('change'));
};

beforeEach(async () => {
  fake = installChrome();
  loadPanelHtml();
  applied = [];
  picker = createTemplatePicker({ apply: (t) => applied.push(t), current: () => fields });
});
afterEach(() => vi.unstubAllGlobals());

async function open(stored: Template[] = []) {
  fake.storage.local.templates = stored;
  picker.show(false);
  await flush();
}

describe('listing', () => {
  it('lists the saved templates after None, and is hidden for a review', async () => {
    await open([template('a', 'App'), template('b', 'Web')]);
    expect(options()).toEqual(['None', 'App', 'Web']);
    expect($('create-templates').hidden).toBe(false);
    picker.show(true);
    expect($('create-templates').hidden).toBe(true);
  });

  it("lists the team's under their own heading, and says why when they could not be read", async () => {
    await open([template('a', 'App')]);
    picker.setTeam([template('team:x', 'Shared')], null);
    expect($('create-template').querySelector('optgroup')!.label).toBe('Team');
    expect(options()).toEqual(['None', 'App', 'Shared']);
    picker.setTeam([], 'no file');
    expect($('create-templates').title).toBe('Team templates: no file');
    expect($('create-template').querySelector('optgroup')).toBeNull();
  });
});

describe('picking', () => {
  it('applies the chosen template, and offers to delete only a personal one', async () => {
    await open([template('a', 'App')]);
    picker.setTeam([template('team:x', 'Shared')], null);
    pick('a');
    expect(applied.map((t) => t.id)).toEqual(['a']);
    expect($('template-delete').hidden).toBe(false);
    pick('team:x');
    expect(applied.map((t) => t.id)).toEqual(['a', 'team:x']);
    expect($('template-delete').hidden).toBe(true);
    pick('');
    expect(applied).toHaveLength(2);
    expect($('template-delete').hidden).toBe(true);
  });
});

describe('saving', () => {
  it("asks for a name, fills in the chosen template's name, and focuses the box", async () => {
    await open([template('a', 'App')]);
    pick('a');
    $('template-save').click();
    expect($('template-name-row').hidden).toBe(false);
    expect($<HTMLInputElement>('template-name').value).toBe('App');
    expect(document.activeElement).toBe($('template-name'));
  });

  it('saves the form under the name, selects it, and hides the box; Enter does the same', async () => {
    await open();
    $('template-save').click();
    $<HTMLInputElement>('template-name').value = '  Review setup  ';
    $('template-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await flush();
    const stored = fake.storage.local.templates as Template[];
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'Review setup', ...fields });
    expect($('template-name-row').hidden).toBe(true);
    expect($<HTMLSelectElement>('create-template').value).toBe(stored[0]!.id);
  });

  it('saves nothing for a blank name, and Escape closes the box without saving', async () => {
    await open();
    $('template-save').click();
    $<HTMLInputElement>('template-name').value = '   ';
    $('template-confirm').click();
    await flush();
    expect(fake.storage.local.templates).toEqual([]);
    $('template-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect($('template-name-row').hidden).toBe(true);
  });

  it('replaces a template saved again under the same name', async () => {
    await open([template('a', 'App')]);
    $('template-save').click();
    $<HTMLInputElement>('template-name').value = 'app';
    $('template-confirm').click();
    await flush();
    expect((fake.storage.local.templates as Template[]).map((t) => t.name)).toEqual(['app']);
  });
});

describe('deleting', () => {
  it('removes the selected template and clears the selection', async () => {
    await open([template('a', 'App'), template('b', 'Web')]);
    pick('a');
    $('template-delete').click();
    await flush();
    expect((fake.storage.local.templates as Template[]).map((t) => t.id)).toEqual(['b']);
    expect(options()).toEqual(['None', 'Web']);
    expect($('template-delete').hidden).toBe(true);
  });
});
