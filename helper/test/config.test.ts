import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config';

const parse = (config: Record<string, unknown>) => parseConfig(JSON.stringify({ extensionId: 'abc', ...config }), '/c/config.json');

describe('parseConfig', () => {
  it('fills in defaults, with no repo folders assumed and claude as the command', () => {
    expect(parse({})).toMatchObject({
      defaultCwd: homedir(),
      repoRoots: [],
      repoDirs: {},
      watchRepos: [],
      claudeCommand: 'claude',
      promptsFiles: [],
      templatesFile: null,
      claudeArgs: [],
      defaultModel: null,
      problems: [],
    });
  });

  it('expands ~ in folders and keeps valid entries', () => {
    const config = parse({
      repoRoots: ['~/code'],
      repoDirs: { 'acme/app': '~/code/app' },
      watchRepos: ['acme/api'],
      claudeCommand: 'wrap',
      defaultModel: 'opus',
    });
    expect(config).toMatchObject({
      repoRoots: [join(homedir(), 'code')],
      repoDirs: { 'acme/app': join(homedir(), 'code/app') },
      watchRepos: ['acme/api'],
      claudeCommand: 'wrap',
      defaultModel: 'opus',
      problems: [],
    });
  });

  it('expands ~ in the extra prompt notes and the templates file', () => {
    expect(parse({ promptsFiles: ['~/team/prompts.md'], templatesFile: '~/team/templates.json' })).toMatchObject({
      promptsFiles: [join(homedir(), 'team/prompts.md')],
      templatesFile: join(homedir(), 'team/templates.json'),
      problems: [],
    });
    expect(parse({ promptsFiles: '~/team/prompts.md', templatesFile: 3 })).toMatchObject({
      promptsFiles: [],
      templatesFile: null,
      problems: ['templatesFile must be a string.', 'promptsFiles must be a list.'],
    });
  });

  it('keeps claude arguments that are plain words, expands ~ in them, and drops anything shell-like', () => {
    const config = parse({ claudeArgs: ['--permission-mode', 'acceptEdits', '--add-dir', '~/shared', 'bad arg', '$(boom)', "it's", 7] });
    expect(config.claudeArgs).toEqual(['--permission-mode', 'acceptEdits', '--add-dir', join(homedir(), 'shared')]);
    expect(config.problems).toEqual([
      'claudeArgs entry "bad arg" is ignored.',
      'claudeArgs entry "$(boom)" is ignored.',
      'claudeArgs entry "it\'s" is ignored.',
      'claudeArgs entry 7 is ignored.',
    ]);
    expect(parse({ claudeArgs: '--verbose' })).toMatchObject({ claudeArgs: [], problems: ['claudeArgs must be a list.'] });
  });

  it('drops repo names that are not plain owner/name, since they reach a gh command line', () => {
    const config = parse({ watchRepos: ['acme/api', 'acme/api; rm -rf ~', 'noslash'], repoDirs: { '$(boom)/x': '~/x', 'acme/app': 3 } });
    expect(config.watchRepos).toEqual(['acme/api']);
    expect(config.repoDirs).toEqual({});
    expect(config.problems).toHaveLength(4);
  });

  it('names unknown keys, bad values and a command that is not a bare name, and falls back for each', () => {
    const config = parse({
      repoRoot: ['~/code'],
      defaultModel: 'opus; rm',
      claudeCommand: 'wrap --flag',
      jiraBaseUrl: 'http://acme.atlassian.net',
      repoRoots: '~/code',
    });
    expect(config).toMatchObject({ defaultModel: null, claudeCommand: 'claude', jiraBaseUrl: null, repoRoots: [] });
    expect(config.problems).toEqual([
      'Unknown key "repoRoot" is ignored.',
      'defaultModel "opus; rm" is not a model name, so it is ignored.',
      'jiraBaseUrl must be an https address, so it is ignored.',
      'claudeCommand "wrap --flag" must be a bare command name, so claude is used.',
      'repoRoots must be a list.',
    ]);
  });

  it('fails with the file name on broken JSON or a missing extension id', () => {
    expect(() => parseConfig('{ "extensionId": ', '/c/config.json')).toThrow(/\/c\/config.json is not valid JSON/);
    expect(() => parseConfig('[]', '/c/config.json')).toThrow(/must hold a JSON object/);
    expect(() => parseConfig('{}', '/c/config.json')).toThrow(/no extensionId; run npm run setup/);
  });
});
