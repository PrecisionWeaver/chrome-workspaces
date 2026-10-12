import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../shared/protocol';
import { launchSpec, monitorSpec, shellSpec } from '../src/launch';

const workspace: Workspace = {
  id: 'ws-0123abcd',
  name: 'PROJ-1',
  ticket: 'PROJ-1',
  cwd: '/Users/me/project',
  url: null,
  windowId: 1,
  groupId: null,
  resume: null,
  pinned: false,
  color: null,
  model: null,
  lastTabUrls: [],
  pr: null,
  prompt: null,
  createdAt: '2026-01-01T00:00:00Z',
};
const RESUME = '169128c8-8b10-48e0-993f-a743c8fad9ef';
const start = (args = '') => `claude${args}`;

describe('launchSpec', () => {
  it('starts claude in a login shell that remains after it quits', () => {
    const spec = launchSpec(workspace, { shell: '/bin/zsh', resumeId: null });
    expect(spec).toMatchObject({ id: 'ws-0123abcd', command: '/bin/zsh', cwd: '/Users/me/project' });
    expect(spec.args).toEqual(['-l', '-i', '-c', `${start()}; exec /bin/zsh -l -i`]);
  });

  it('starts a configured wrapper with the same arguments, falling back to claude when the shell cannot find it', () => {
    const spec = launchSpec({ ...workspace, model: 'opus' }, { shell: '/bin/zsh', resumeId: null, command: 'wrap' });
    expect(spec.args[3]).toBe("if command -v wrap >/dev/null 2>&1; then wrap --model 'opus'; else claude --model 'opus'; fi; exec /bin/zsh -l -i");
  });

  it('adds the status hooks through the environment, so the path is never parsed as shell syntax', () => {
    const spec = launchSpec(workspace, { shell: '/bin/zsh', resumeId: RESUME, hooksFile: '/Users/me/.chrome-workspaces/hooks.json' });
    expect(spec.args[3]).toBe(`${start(` --resume ${RESUME} --settings "$CW_HOOKS"`)}; exec /bin/zsh -l -i`);
    expect(spec.env).toMatchObject({ CW_HOOKS: '/Users/me/.chrome-workspaces/hooks.json' });
    expect(launchSpec(workspace, { shell: '/bin/zsh', resumeId: null, hooksFile: null }).env).not.toHaveProperty('CW_HOOKS');
  });

  it('resumes a known Claude session by id', () => {
    expect(launchSpec(workspace, { shell: '/bin/zsh', resumeId: RESUME }).args[3]).toBe(`${start(` --resume ${RESUME}`)}; exec /bin/zsh -l -i`);
  });

  it('ignores a resume id that is not a plain session uuid', () => {
    const spec = launchSpec(workspace, { shell: '/bin/zsh', resumeId: `${RESUME}; rm -rf ~` });
    expect(spec.args[3]).toBe(`${start()}; exec /bin/zsh -l -i`);
  });

  it('passes the chosen model, else the default, and drops one that is not a plain id', () => {
    const options = { shell: '/bin/zsh', resumeId: null };
    expect(launchSpec({ ...workspace, model: 'opus' }, options).args[3]).toBe(`${start(" --model 'opus'")}; exec /bin/zsh -l -i`);
    expect(launchSpec(workspace, { ...options, defaultModel: 'sonnet' }).args[3]).toBe(`${start(" --model 'sonnet'")}; exec /bin/zsh -l -i`);
    expect(launchSpec({ ...workspace, model: 'opus' }, { ...options, defaultModel: 'sonnet' }).args[3]).toContain("--model 'opus'");
    expect(launchSpec({ ...workspace, model: "x'; rm -rf ~; '" }, options).args[3]).toBe(`${start()}; exec /bin/zsh -l -i`);
  });

  it('puts the model before the resume id', () => {
    expect(launchSpec({ ...workspace, model: 'opus[1m]' }, { shell: '/bin/zsh', resumeId: RESUME }).args[3]).toBe(
      `${start(` --model 'opus[1m]' --resume ${RESUME}`)}; exec /bin/zsh -l -i`,
    );
  });

  it('tags the session with its workspace and ticket', () => {
    expect(launchSpec(workspace, { shell: '/bin/zsh', resumeId: null }).env).toEqual({ CW_WORKSPACE_ID: 'ws-0123abcd', DEVSPACE_TICKET: 'PROJ-1' });
    expect(launchSpec({ ...workspace, ticket: null }, { shell: '/bin/zsh', resumeId: null }).env).toEqual({ CW_WORKSPACE_ID: 'ws-0123abcd' });
  });

  it('sends the prompt as the first message through the environment, never the command', () => {
    const prompt = `/code-review "it's" $(touch /tmp/pwned) \`id\``;
    const spec = launchSpec({ ...workspace, prompt }, { shell: '/bin/zsh', resumeId: null });
    expect(spec.args[3]).toBe(`${start(' "$CW_PROMPT"')}; unset CW_PROMPT; exec /bin/zsh -l -i`);
    expect(spec.env?.CW_PROMPT).toBe(prompt);
  });

  it('resumes rather than re-sending the prompt', () => {
    const spec = launchSpec({ ...workspace, prompt: 'go' }, { shell: '/bin/zsh', resumeId: RESUME });
    expect(spec.args[3]).toBe(`${start(` --resume ${RESUME}`)}; exec /bin/zsh -l -i`);
    expect(spec.env).not.toHaveProperty('CW_PROMPT');
  });
});

describe('monitorSpec', () => {
  it('runs btop, or top without it, in a login shell that ends with the program', () => {
    expect(monitorSpec('/bin/zsh', '/Users/me')).toEqual({
      id: 'monitor',
      command: '/bin/zsh',
      args: ['-l', '-i', '-c', 'if command -v btop >/dev/null 2>&1; then exec btop; else exec top; fi'],
      cwd: '/Users/me',
    });
  });
});

describe('shellSpec', () => {
  it('is a plain login shell with no workspace in its environment, so a claude typed in it is not tracked', () => {
    const spec = shellSpec('/bin/zsh', '/Users/me/code');
    expect(spec).toEqual({ id: 'shell', command: '/bin/zsh', args: ['-l', '-i'], cwd: '/Users/me/code' });
    expect(spec).not.toHaveProperty('env');
  });
});
