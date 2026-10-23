import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_SCRIPT, hooksSettings, typeStrippingSupported, writeHooksFile } from '../src/hooks-config';

describe('typeStrippingSupported', () => {
  it('needs Node 22.18 or newer', () => {
    expect(['22.17.9', '20.19.0', '18.0.0'].map(typeStrippingSupported)).toEqual([false, false, false]);
    expect(['22.18.0', '22.23.2', '24.0.0'].map(typeStrippingSupported)).toEqual([true, true, true]);
  });
});

describe('hooksSettings', () => {
  it('runs one quoted command for each tracked event, whatever is in the paths', () => {
    const { hooks } = hooksSettings('/Users/me/Application Support/node', "/code/it's here/session-state.ts");
    expect(Object.keys(hooks).sort()).toEqual([
      'Notification',
      'PostToolUse',
      'PostToolUseFailure',
      'PreCompact',
      'PreToolUse',
      'SessionEnd',
      'SessionStart',
      'Stop',
      'SubagentStart',
      'SubagentStop',
      'UserPromptSubmit',
    ]);
    expect(hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: `'/Users/me/Application Support/node' '/code/it'\\''s here/session-state.ts'` }] }]);
  });
});

describe('hooksSettings status line', () => {
  it('runs the wrapper as the status line when there is one, and has none otherwise', () => {
    expect(hooksSettings('/n/node', '/h.ts', "/code/it's/status-line.ts").statusLine).toEqual({
      type: 'command',
      command: `'/n/node' '/code/it'\\''s/status-line.ts'`,
    });
    expect(hooksSettings('/n/node', '/h.ts')).not.toHaveProperty('statusLine');
  });
});

describe('writeHooksFile', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'cw-hooks-'));

  it('writes the settings file into the data directory, and rewrites it for a new Node', () => {
    const data = dir();
    const file = writeHooksFile(data, '/n/node-a');
    expect(file).toBe(join(data, 'hooks.json'));
    expect(readFileSync(file!, 'utf8')).toContain(`'/n/node-a' '${HOOK_SCRIPT}'`);
    writeHooksFile(data, '/n/node-b');
    expect(readFileSync(file!, 'utf8')).toContain("'/n/node-b'");
  });

  it('writes nothing when the script is missing or Node cannot run it', () => {
    const data = dir();
    const script = join(dir(), 'session-state.ts');
    expect(writeHooksFile(data, '/n/node', script)).toBeNull();
    writeFileSync(script, '');
    expect(writeHooksFile(data, '/n/node', script, '22.17.0')).toBeNull();
    expect(existsSync(join(data, 'hooks.json'))).toBe(false);
    expect(writeHooksFile(data, '/n/node', script, '22.18.0')).not.toBeNull();
  });
});
