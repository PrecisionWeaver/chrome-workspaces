import { describe, expect, it } from 'vitest';
import { MAX_TEMPLATES, parseTemplates, removeTemplate, upsertTemplate, type Template } from '../../shared/templates';

const t = (id: string, name: string, extra: Partial<Template> = {}): Template => ({
  id,
  name,
  repo: '',
  model: '',
  tabs: '',
  message: '',
  window: 'new',
  ...extra,
});

describe('parseTemplates', () => {
  it('keeps well-formed templates, fills defaults, and drops anything else', () => {
    const stored = [
      { id: 'a', name: ' PR review ', repo: '/code/app', model: 'opus', tabs: 'a.example', message: 'go', window: 'here' },
      { id: 'b', name: 'Minimal' },
      { name: 'no id' },
      { id: 'c', name: '  ' },
      null,
      'junk',
      7,
    ];
    expect(parseTemplates(stored)).toEqual([
      { id: 'a', name: 'PR review', repo: '/code/app', model: 'opus', tabs: 'a.example', message: 'go', window: 'here' },
      { id: 'b', name: 'Minimal', repo: '', model: '', tabs: '', message: '', window: 'new' },
    ]);
    expect(parseTemplates(undefined)).toEqual([]);
    expect(parseTemplates({ not: 'a list' })).toEqual([]);
  });

  it('caps the count', () => {
    const many = Array.from({ length: MAX_TEMPLATES + 5 }, (_, i) => ({ id: `${i}`, name: `t${i}` }));
    expect(parseTemplates(many)).toHaveLength(MAX_TEMPLATES);
  });
});

describe('upsertTemplate and removeTemplate', () => {
  it('replaces a template of the same name in place, keeping its id, and appends a new one', () => {
    const list = [t('1', 'Review'), t('2', 'Triage')];
    const updated = upsertTemplate(list, t('9', 'review', { model: 'opus' }));
    expect(updated.map((x) => [x.id, x.name, x.model])).toEqual([
      ['1', 'review', 'opus'],
      ['2', 'Triage', ''],
    ]);
    expect(upsertTemplate(list, t('3', 'New')).map((x) => x.id)).toEqual(['1', '2', '3']);
  });

  it('drops the oldest when full, and removes by id', () => {
    const full = Array.from({ length: MAX_TEMPLATES }, (_, i) => t(`${i}`, `t${i}`));
    const next = upsertTemplate(full, t('new', 'brand new'));
    expect(next).toHaveLength(MAX_TEMPLATES);
    expect(next[0].id).toBe('1');
    expect(removeTemplate(next, 'new').find((x) => x.id === 'new')).toBeUndefined();
  });
});
