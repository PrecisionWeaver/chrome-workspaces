import { describe, expect, it } from 'vitest';
import { buildChecklist, remaining, type SetupInput } from '../../shared/onboarding';

const ready: SetupInput = {
  managed: true,
  helperExtensionId: 'abc',
  extensionId: 'abc',
  reviewsWork: true,
  promptsFileExists: true,
  repoRoots: [{ path: '~/code', exists: true }],
  switchShortcut: '⌃⇧→',
  workspaceCount: 2,
  statusHooks: true,
  configProblems: [],
};

describe('buildChecklist', () => {
  it('is all done for a working install, with nothing to fix', () => {
    const items = buildChecklist(ready);
    expect(remaining(items)).toBe(0);
    expect(items.every((item) => item.fix === undefined)).toBe(true);
    expect(items.map((item) => item.id)).toEqual(['agent', 'extension', 'config', 'status-hooks', 'github', 'prompts', 'repos', 'shortcut', 'workspace']);
  });

  it('says what is wrong and how to fix it, for each thing that is', () => {
    const items = buildChecklist({
      ...ready,
      managed: false,
      helperExtensionId: 'old',
      reviewsWork: false,
      promptsFileExists: false,
      switchShortcut: '',
      workspaceCount: 0,
    });
    expect(remaining(items)).toBe(6);
    const by = Object.fromEntries(items.map((item) => [item.id, item]));
    expect(by.agent.fix).toContain('npm run agent:start');
    expect(by.extension.detail).toContain('old');
    expect(by.github.fix).toContain('gh auth login');
    expect(by.shortcut.fix).toContain('chrome://extensions/shortcuts');
    expect(by.workspace.fix).toContain('New workspace');
    expect(by.repos.ok).toBe(true);
  });

  it('names the repo folders that are missing, and treats no folders as a problem', () => {
    const missing = buildChecklist({
      ...ready,
      repoRoots: [
        { path: '~/a', exists: true },
        { path: '~/b', exists: false },
        { path: '~/c', exists: false },
      ],
    }).find((i) => i.id === 'repos')!;
    expect(missing).toMatchObject({ ok: false, detail: 'Not found: ~/b, ~/c.' });
    expect(buildChecklist({ ...ready, repoRoots: [] }).find((i) => i.id === 'repos')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('None are configured'),
    });
  });

  it('lists ignored config entries, and says what is lost without the status hooks', () => {
    const by = Object.fromEntries(
      buildChecklist({ ...ready, statusHooks: false, configProblems: ['Unknown key "repoRoot" is ignored.'] }).map((item) => [item.id, item]),
    );
    expect(by.config).toMatchObject({ ok: false, detail: 'Unknown key "repoRoot" is ignored.' });
    expect(by.config.fix).toContain('configuration.md');
    expect(by['status-hooks']).toMatchObject({ ok: false, detail: expect.stringContaining('status dots') });
  });
});
