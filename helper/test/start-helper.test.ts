import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startHelper, type Launchctl } from '../src/start-helper';

const LABEL = 'gui/501/com.chrome-workspaces.helper';

function plistFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'cw-agent-')), 'agent.plist');
  writeFileSync(file, '<plist/>');
  return file;
}

function recorder(loaded: boolean) {
  const calls: string[][] = [];
  const launchctl: Launchctl = async (args) => {
    calls.push(args);
    if (args[0] === 'print' && !loaded) throw new Error('Could not find service');
  };
  return { calls, launchctl };
}

describe('startHelper', () => {
  it('bootstraps the agent when it is not loaded', async () => {
    const plist = plistFile();
    const { calls, launchctl } = recorder(false);
    await startHelper(launchctl, plist, 501);
    expect(calls).toEqual([
      ['print', LABEL],
      ['bootstrap', 'gui/501', plist],
    ]);
  });

  it('kickstarts an agent that is loaded but not running', async () => {
    const { calls, launchctl } = recorder(true);
    await startHelper(launchctl, plistFile(), 501);
    expect(calls).toEqual([
      ['print', LABEL],
      ['kickstart', LABEL],
    ]);
  });

  it('says to run setup when the agent was never installed', async () => {
    const { calls, launchctl } = recorder(false);
    await expect(startHelper(launchctl, '/nonexistent/agent.plist', 501)).rejects.toThrow('npm run setup');
    expect(calls).toEqual([['print', LABEL]]);
  });
});
