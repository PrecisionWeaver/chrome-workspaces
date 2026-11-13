import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { waitFor } from '../../testing/wait-for';
import { defaultIsManaged, defaultRunShell, defaultSpawnDetached, launchctl } from './shell';

describe('defaultRunShell', () => {
  it('runs a command line in a login shell and gives both of its streams', async () => {
    const run = defaultRunShell('/bin/sh');
    const { output, ok } = await run('echo out; echo err 1>&2');
    expect(ok).toBe(true);
    expect(output.split('\n')).toEqual(expect.arrayContaining(['out', 'err']));
  });

  it('reports a failing command with what it printed, or the error when it printed nothing', async () => {
    const run = defaultRunShell('/bin/sh');
    const printed = await run('echo nope; exit 3');
    expect(printed.ok).toBe(false);
    expect(printed.output).toContain('nope');
    const silent = await run('exit 3');
    expect(silent.ok).toBe(false);
    expect(silent.output).not.toBe('');
    const missing = await defaultRunShell('/Users/me/no-such-shell')('true');
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain('ENOENT');
  });
});

describe('defaultSpawnDetached', () => {
  it('starts the command without waiting for it', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'cw-shell-')), 'ran');
    defaultSpawnDetached(`sleep 0.1; echo done > "${marker}"`);
    expect(existsSync(marker)).toBe(false);
    await waitFor(() => existsSync(marker));
  });
});

describe('defaultIsManaged', () => {
  it('is false for a process launchd did not start', async () => {
    expect(await defaultIsManaged()).toBe(false);
  });
});

describe('launchctl', () => {
  it("addresses the helper's agent in the user's domain, after a pause for the reply to go out", () => {
    expect(launchctl('kickstart -k')).toMatch(/^sleep 1; launchctl kickstart -k gui\/\d+\/com\.chrome-workspaces\.helper$/);
    expect(launchctl('bootout')).toMatch(/^sleep 1; launchctl bootout gui\/\d+\/com\.chrome-workspaces\.helper$/);
  });
});
