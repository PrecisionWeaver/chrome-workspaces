import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTemplatesFile } from '../src/templates-file';

describe('readTemplatesFile', () => {
  it('reads a JSON list of templates, giving each an id from its place, and keeps only well-formed ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-templates-'));
    const file = join(dir, 'templates.json');
    writeFileSync(file, JSON.stringify([{ name: 'Review', repo: '~/code/app', model: 'opus', worktree: true }, { nope: true }, { name: 'Min' }]));
    expect(readTemplatesFile(file)).toEqual([
      { id: 'team:0', name: 'Review', repo: '~/code/app', model: 'opus', tabs: '', message: '', window: 'new', worktree: true },
      { id: 'team:2', name: 'Min', repo: '', model: '', tabs: '', message: '', window: 'new', worktree: false },
    ]);
  });

  it('is empty for no file, and says what is wrong with one it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-templates-'));
    expect(readTemplatesFile(null)).toEqual([]);
    expect(() => readTemplatesFile(join(dir, 'missing.json'))).toThrow('missing.json');
    writeFileSync(join(dir, 'bad.json'), '{"not": "a list"}');
    expect(() => readTemplatesFile(join(dir, 'bad.json'))).toThrow('a list');
  });
});
