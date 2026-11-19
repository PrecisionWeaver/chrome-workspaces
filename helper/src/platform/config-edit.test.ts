import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from './config';
import { configEditProblems, readConfigEdit, saveConfigEdit } from './config-edit';

let dir: string;
let file: string;
let notes: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cw-config-edit-'));
  file = join(dir, 'config.json');
  notes = join(dir, 'prompts.md');
  mkdirSync(join(dir, 'code'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const write = (config: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ extensionId: 'abc', promptsFile: notes, ...config }, null, 2));
const load = () => parseConfig(readFileSync(file, 'utf8'), file);
const blankValues = () => ({ defaultCwd: '', defaultModel: '', claudeCommand: '', promptsFile: notes });
const saved = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

describe('readConfigEdit', () => {
  it('returns the fields as the file spells them, and the note they name', () => {
    writeFileSync(notes, '**Review**\n- check it\n');
    write({ defaultCwd: '~/code', defaultModel: 'opus', claudeCommand: 'hr' });
    expect(readConfigEdit(file, load())).toEqual({
      values: { defaultCwd: '~/code', defaultModel: 'opus', claudeCommand: 'hr', promptsFile: notes },
      promptsPath: notes,
      prompts: '**Review**\n- check it\n',
    });
  });

  it('reads an unset field as empty and a missing note as null', () => {
    write({ promptsFile: undefined });
    const edit = readConfigEdit(file, load());
    expect(edit.values).toEqual({ defaultCwd: '', defaultModel: '', claudeCommand: '', promptsFile: '' });
    expect(edit.prompts).toBeNull();
  });
});

describe('configEditProblems', () => {
  it('accepts blank fields, which fall back to the defaults', () => {
    expect(configEditProblems({ ...blankValues(), promptsFile: '' }, null)).toEqual([]);
  });

  it('names each field that would be dropped', () => {
    const problems = configEditProblems(
      { defaultCwd: join(dir, 'missing'), defaultModel: 'not a model!', claudeCommand: '/bin/sh -c x', promptsFile: notes },
      null,
    );
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toContain('is not a folder');
    expect(problems.join(' ')).toContain('is not a model name');
    expect(problems.join(' ')).toContain('bare command name');
  });

  it('refuses a note that is too large or whose folder does not exist', () => {
    expect(configEditProblems(blankValues(), 'x'.repeat(512 * 1024 + 1))).toEqual(['The prompts note is over 512 KB.']);
    expect(configEditProblems({ ...blankValues(), promptsFile: join(dir, 'nope', 'p.md') }, 'text')[0]).toContain('does not exist');
    // The text is written to the path, so it must look like a note.
    for (const bad of [join(dir, '.zshrc'), join(dir, 'authorized_keys'), join(dir, '.hidden.md')]) {
      expect(configEditProblems({ ...blankValues(), promptsFile: bad }, 'text')).toEqual([
        'The prompts file must be a .md or .txt file whose name does not start with a dot.',
      ]);
    }
    expect(configEditProblems({ ...blankValues(), promptsFile: join(dir, 'team.txt') }, 'text')).toEqual([]);
  });
});

describe('saveConfigEdit', () => {
  it('writes the four fields, keeps every other entry, and applies them to the running config', () => {
    write({ repoRoots: ['~/code'], somethingElse: { kept: true } });
    const config = load();
    const result = saveConfigEdit(file, config, { defaultCwd: join(dir, 'code'), defaultModel: 'sonnet', claudeCommand: 'hr', promptsFile: notes }, null);
    expect(result.ok).toBe(true);
    expect(saved()).toMatchObject({
      extensionId: 'abc',
      defaultCwd: join(dir, 'code'),
      defaultModel: 'sonnet',
      claudeCommand: 'hr',
      repoRoots: ['~/code'],
      somethingElse: { kept: true },
    });
    expect(config).toMatchObject({ defaultCwd: join(dir, 'code'), defaultModel: 'sonnet', claudeCommand: 'hr', promptsFile: notes });
    expect(config.repoRoots).toEqual(['~/code'.replace('~', process.env.HOME ?? '~')]);
  });

  it('removes a field that is emptied, so its default applies again', () => {
    write({ defaultModel: 'opus', claudeCommand: 'hr' });
    const config = load();
    saveConfigEdit(file, config, blankValues(), null);
    expect(saved()).not.toHaveProperty('defaultModel');
    expect(saved()).not.toHaveProperty('claudeCommand');
    expect(config.defaultModel).toBeNull();
    expect(config.claudeCommand).toBe('claude');
  });

  it('writes nothing, and leaves the config alone, while any value is invalid', () => {
    write({ defaultModel: 'opus' });
    const before = readFileSync(file, 'utf8');
    const config = load();
    const result = saveConfigEdit(file, config, { ...blankValues(), claudeCommand: 'a b', defaultModel: 'sonnet' }, 'new note');
    expect(result).toMatchObject({ ok: false });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(config.defaultModel).toBe('opus');
    expect(() => readFileSync(notes)).toThrow();
  });

  it('writes the note to the file the saved config names, and only when text is given', () => {
    write({});
    const config = load();
    saveConfigEdit(file, config, blankValues(), null);
    expect(() => readFileSync(notes)).toThrow();
    saveConfigEdit(file, config, blankValues(), '**Review**\n- check it\n');
    expect(readFileSync(notes, 'utf8')).toBe('**Review**\n- check it\n');
    const moved = join(dir, 'code', 'team.md');
    saveConfigEdit(file, config, { ...blankValues(), promptsFile: moved }, 'moved');
    expect(readFileSync(moved, 'utf8')).toBe('moved');
    expect(config.promptsFile).toBe(moved);
  });

  it('keeps the config file permissions', () => {
    write({});
    chmodSync(file, 0o600);
    saveConfigEdit(file, load(), blankValues(), null);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('reports a config file it cannot read, without touching the note', () => {
    writeFileSync(file, '{ not json');
    const result = saveConfigEdit(file, parseConfig('{"extensionId":"abc"}', file), blankValues(), 'text');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Could not save');
    expect(() => readFileSync(notes)).toThrow();
  });

  it('says so when the settings saved but the note could not be written', () => {
    write({});
    const config = load();
    // The note's path is a folder, so replacing it fails after the config was written.
    mkdirSync(join(dir, 'code', 'taken.md'));
    const result = saveConfigEdit(file, config, { ...blankValues(), promptsFile: join(dir, 'code', 'taken.md') }, 'text');
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain('Saved the settings, but could not write');
    expect(saved().promptsFile).toBe(join(dir, 'code', 'taken.md'));
  });
});
