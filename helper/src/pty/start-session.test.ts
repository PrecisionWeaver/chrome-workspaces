import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MONITOR_SESSION, SHELL_SESSION } from '../../../shared/protocol/protocol';
import type { Workspace } from '../../../shared/protocol/workspace';
import type { Session, SessionSpec } from './session';
import { startSession, type StartSessionDeps } from './start-session';

const RESUME = '169128c8-8b10-48e0-993f-a743c8fad9ef';
const OTHER = '22222222-2222-2222-2222-222222222222';
const workspace = (over: Partial<Workspace> = {}): Workspace => ({
  id: 'ws-0123abcd',
  name: 'acme/app',
  ticket: null,
  cwd: '/repo',
  url: null,
  windowId: null,
  groupId: null,
  grouped: false,
  resume: null,
  pinned: false,
  color: null,
  model: null,
  lastTabUrls: [],
  pr: null,
  prompt: null,
  createdAt: '2026-01-01T00:00:00Z',
  ...over,
});

function setup(workspaces: Workspace[] = [workspace()], over: Partial<StartSessionDeps> = {}) {
  const created: SessionSpec[] = [];
  const clearPrompt = vi.fn();
  const log = vi.fn();
  const deps: StartSessionDeps = {
    shell: '/bin/zsh',
    defaultCwd: tmpdir(),
    home: '/Users/me',
    hooksFile: null,
    store: { get: (id) => workspaces.find((w) => w.id === id), clearPrompt },
    sessions: { create: (spec) => (created.push(spec), { id: spec.id } as Session) },
    resumeOverride: new Map(),
    claudeSessionId: () => null,
    workingDir: () => null,
    launchDirectory: (cwd, last) => last ?? cwd,
    log,
    ...over,
  };
  return { deps, created, clearPrompt, log, start: (id: string) => startSession(id, deps) };
}

describe('startSession', () => {
  it('starts the monitor in the home directory and the plain terminal in the default one', () => {
    const { start, created, deps } = setup();
    start(MONITOR_SESSION);
    start(SHELL_SESSION);
    expect(created.map((spec) => [spec.id, spec.cwd])).toEqual([
      [MONITOR_SESSION, '/Users/me'],
      [SHELL_SESSION, deps.defaultCwd],
    ]);
  });

  it("starts a workspace's own shell in its directory, or the default one when that is gone, and not for an unknown workspace", () => {
    const here = mkdtempSync(join(tmpdir(), 'cw-start-'));
    const { start, created, deps } = setup([workspace({ cwd: here }), workspace({ id: 'ws-gone0000', cwd: '/no/such/dir' })]);
    start('shell-ws-0123abcd');
    start('shell-ws-gone0000');
    expect(created.map((spec) => spec.cwd)).toEqual([here, deps.defaultCwd]);
    expect(created.map((spec) => spec.id)).toEqual(['shell-ws-0123abcd', 'shell-ws-gone0000']);
    expect(start('shell-ws-unknown0')).toBeUndefined();
    expect(start('ws-unknown0')).toBeUndefined();
  });

  it("starts claude in the workspace's directory for a new conversation, asking git for no directory", () => {
    const launchDirectory = vi.fn();
    const { start, created, log } = setup([workspace()], { launchDirectory });
    start('ws-0123abcd');
    expect(created[0]).toMatchObject({ id: 'ws-0123abcd', cwd: '/repo' });
    expect(created[0].args.join(' ')).not.toContain('--resume');
    expect(launchDirectory).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('started acme/app in /repo');
  });

  it("resumes the picked conversation first, then the hooks' one, then the workspace's own, in the directory claude was last in", () => {
    const resume = (over: Partial<StartSessionDeps>, ws = workspace({ resume: 'ignored' })) => {
      const { start, created, log, deps } = setup([ws], { workingDir: () => '/repo/.worktrees/topic', ...over });
      start('ws-0123abcd');
      return { spec: created[0], log, deps };
    };
    const picked = resume({ resumeOverride: new Map([['ws-0123abcd', RESUME]]), claudeSessionId: () => OTHER });
    expect(picked.spec.args.join(' ')).toContain(`--resume ${RESUME}`);
    expect(picked.spec.cwd).toBe('/repo/.worktrees/topic');
    expect(picked.log).toHaveBeenCalledWith('started acme/app in /repo/.worktrees/topic, resuming its conversation');
    // The pick is for one start only.
    expect(picked.deps.resumeOverride.size).toBe(0);

    expect(resume({ claudeSessionId: () => OTHER }).spec.args.join(' ')).toContain(`--resume ${OTHER}`);
    expect(resume({}, workspace({ resume: RESUME })).spec.args.join(' ')).toContain(`--resume ${RESUME}`);
  });

  it('sends a first prompt once: with the launch, and then clears it from the workspace', () => {
    const { start, created, clearPrompt } = setup([workspace({ prompt: 'fix the bug' })]);
    start('ws-0123abcd');
    expect(created[0].env?.CW_PROMPT).toBe('fix the bug');
    expect(clearPrompt).toHaveBeenCalledWith('ws-0123abcd');
  });

  it('does not clear a prompt that was not sent because a conversation was resumed', () => {
    const { start, clearPrompt } = setup([workspace({ prompt: 'fix the bug', resume: RESUME })]);
    start('ws-0123abcd');
    expect(clearPrompt).not.toHaveBeenCalled();
  });

  it('passes the configured model, command, arguments and hooks to the launch', () => {
    const { start, created } = setup([workspace()], { defaultModel: 'haiku', claudeCommand: 'wrap', claudeArgs: ['--verbose'], hooksFile: '/data/hooks.json' });
    start('ws-0123abcd');
    const command = created[0].args.at(-1) ?? '';
    expect(command).toContain("--model 'haiku'");
    expect(command).toContain('wrap');
    expect(command).toContain("'--verbose'");
    expect(created[0].env?.CW_HOOKS).toBe('/data/hooks.json');
  });
});
