import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_HOST_NAME } from '../shared/protocol/protocol';
import { agentPlist, hostManifestJson, hostWrapperScript, mergedConfig } from './setup-files';

describe('mergedConfig', () => {
  it('keeps what the config had, and sets the extension id and start directory', () => {
    const merged = JSON.parse(
      mergedConfig({ defaultModel: 'opus', repoRoots: ['/Users/me/code'], extensionId: 'old' }, { extensionId: 'new', defaultCwd: '/Users/me', repoRoots: [] }),
    );
    expect(merged).toEqual({ defaultModel: 'opus', repoRoots: ['/Users/me/code'], extensionId: 'new', defaultCwd: '/Users/me' });
  });

  it('replaces the repo folders only when some were given', () => {
    const set = { extensionId: 'id', defaultCwd: '/Users/me', repoRoots: ['/Users/me/work'] };
    expect(JSON.parse(mergedConfig({ repoRoots: ['/Users/me/code'] }, set)).repoRoots).toEqual(['/Users/me/work']);
    expect(mergedConfig({}, set).endsWith('}\n')).toBe(true);
  });
});

describe('hostWrapperScript', () => {
  it('starts the native host from the repository with the node that ran setup', () => {
    expect(hostWrapperScript('/Users/me/code/chrome workspaces', '/opt/node/bin/node')).toBe(
      '#!/bin/sh\ncd "/Users/me/code/chrome workspaces" && exec "/opt/node/bin/node" --import tsx helper/src/native-host.ts\n',
    );
  });
});

describe('hostManifestJson', () => {
  it('names the wrapper and allows only this extension', () => {
    expect(JSON.parse(hostManifestJson('/Users/me/.chrome-workspaces/native-host.sh', 'abcdefghijklmnopabcdefghijklmnop'))).toEqual({
      name: NATIVE_HOST_NAME,
      description: 'Chrome Workspaces token bridge',
      path: '/Users/me/.chrome-workspaces/native-host.sh',
      type: 'stdio',
      allowed_origins: ['chrome-extension://abcdefghijklmnopabcdefghijklmnop/'],
    });
  });
});

describe('agentPlist', () => {
  const plist = agentPlist({
    label: 'com.chrome-workspaces.helper',
    node: '/opt/node/bin/node',
    repo: '/Users/me/code/R&D <apps>',
    shell: '/bin/zsh',
    lang: 'en_US.UTF-8',
    logFile: '/Users/me/.chrome-workspaces/helper.log',
  });

  // plutil ships with macOS and is what launchd's own tools use to read one, so this runs only there (CI runs on Linux).
  it.skipIf(process.platform !== 'darwin')('is a property list launchd can read, with paths escaped', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cw-plist-')), 'agent.plist');
    writeFileSync(file, plist);
    const parsed = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
    expect(parsed).toEqual({
      Label: 'com.chrome-workspaces.helper',
      ProgramArguments: ['/opt/node/bin/node', '--import', 'tsx', 'helper/src/main.ts'],
      WorkingDirectory: '/Users/me/code/R&D <apps>',
      EnvironmentVariables: { SHELL: '/bin/zsh', LANG: 'en_US.UTF-8' },
      RunAtLoad: true,
      KeepAlive: true,
      StandardOutPath: '/Users/me/.chrome-workspaces/helper.log',
      StandardErrorPath: '/Users/me/.chrome-workspaces/helper.log',
    });
  });
});
