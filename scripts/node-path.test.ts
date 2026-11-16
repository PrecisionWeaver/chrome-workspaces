import { describe, expect, it } from 'vitest';
import { plistNodePath, wrapperNodePath } from './node-path';

describe('plistNodePath', () => {
  it('reads the first program argument, unescaped', () => {
    const plist = `<dict><key>Label</key><string>x</string><key>ProgramArguments</key>
      <array>
        <string>/Users/me/.nvm/versions/node/v24.1.0/bin/node &amp; co</string>
        <string>--import</string>
      </array></dict>`;
    expect(plistNodePath(plist)).toBe('/Users/me/.nvm/versions/node/v24.1.0/bin/node & co');
  });

  it('is null without program arguments', () => {
    expect(plistNodePath('<dict></dict>')).toBeNull();
  });
});

describe('wrapperNodePath', () => {
  it('reads the binary the wrapper execs', () => {
    expect(wrapperNodePath('#!/bin/sh\ncd "/repo" && exec "/opt/homebrew/Cellar/node/24.1.0/bin/node" --import tsx helper/src/native-host.ts\n')).toBe(
      '/opt/homebrew/Cellar/node/24.1.0/bin/node',
    );
    expect(wrapperNodePath('#!/bin/sh\n')).toBeNull();
  });
});
