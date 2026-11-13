import { describe, expect, it } from 'vitest';
import { MODEL_ALIASES, MODEL_PATTERN, MONITOR_SESSION, SHELL_SESSION, WORKSPACE_COLORS, WORKSPACE_SHELL_PREFIX, workspaceShellSession } from './protocol';

describe('workspaceShellSession', () => {
  it('names a workspace shell apart from the plain shell and the monitor', () => {
    const id = workspaceShellSession('ws1');
    expect(id).toBe(`${WORKSPACE_SHELL_PREFIX}ws1`);
    expect(id).not.toBe(SHELL_SESSION);
    expect(id).not.toBe(MONITOR_SESSION);
    expect(workspaceShellSession('ws2')).not.toBe(id);
  });
});

describe('MODEL_PATTERN', () => {
  it('accepts an alias, a full model id and a context-window suffix', () => {
    for (const alias of MODEL_ALIASES) expect(MODEL_PATTERN.test(alias)).toBe(true);
    expect(MODEL_PATTERN.test('claude-sonnet-5-5')).toBe(true);
    expect(MODEL_PATTERN.test('sonnet[1m]')).toBe(true);
  });

  it('rejects anything a shell could read as more than a word', () => {
    expect(MODEL_PATTERN.test('')).toBe(false);
    expect(MODEL_PATTERN.test('-opus')).toBe(false);
    expect(MODEL_PATTERN.test('opus; rm -rf /')).toBe(false);
    expect(MODEL_PATTERN.test('opus[toolong12]')).toBe(false);
    expect(MODEL_PATTERN.test(`o${'x'.repeat(64)}`)).toBe(false);
  });
});

describe('WORKSPACE_COLORS', () => {
  it('lists each colour once', () => {
    expect(new Set(WORKSPACE_COLORS).size).toBe(WORKSPACE_COLORS.length);
  });
});
