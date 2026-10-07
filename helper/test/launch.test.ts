import { describe, expect, it } from 'vitest';
import type { Workspace } from '../../shared/protocol';
import { launchSpec } from '../src/launch';

const workspace: Workspace = {
  id: 'ws-0123abcd',
  name: 'ORC-1',
  ticket: 'ORC-1',
  cwd: '/Users/me/project',
  url: null,
  windowId: 1,
  lastTabUrls: [],
  createdAt: '2026-01-01T00:00:00Z',
};
const RESUME = '169128c8-8b10-48e0-993f-a743c8fad9ef';

describe('launchSpec', () => {
  it('starts claude in a login shell that remains after claude quits', () => {
    const spec = launchSpec(workspace, { shell: '/bin/zsh', resumeId: null });
    expect(spec).toMatchObject({ id: 'ws-0123abcd', command: '/bin/zsh', cwd: '/Users/me/project' });
    expect(spec.args).toEqual(['-l', '-i', '-c', 'claude; exec /bin/zsh -l -i']);
  });

  it('resumes a known Claude session by id', () => {
    expect(launchSpec(workspace, { shell: '/bin/zsh', resumeId: RESUME }).args[3]).toBe(`claude --resume ${RESUME}; exec /bin/zsh -l -i`);
  });

  it('ignores a resume id that is not a plain session uuid', () => {
    const spec = launchSpec(workspace, { shell: '/bin/zsh', resumeId: `${RESUME}; rm -rf ~` });
    expect(spec.args[3]).toBe('claude; exec /bin/zsh -l -i');
  });

  it('tags the session with its workspace and ticket', () => {
    expect(launchSpec(workspace, { shell: '/bin/zsh', resumeId: null }).env).toEqual({ CW_WORKSPACE_ID: 'ws-0123abcd', DEVSPACE_TICKET: 'ORC-1' });
    expect(launchSpec({ ...workspace, ticket: null }, { shell: '/bin/zsh', resumeId: null }).env).toEqual({ CW_WORKSPACE_ID: 'ws-0123abcd' });
  });
});
