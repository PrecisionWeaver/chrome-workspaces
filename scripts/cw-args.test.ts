import { describe, expect, it } from 'vitest';
import { findWorkspace, parseCommand, usage } from './cw-args';

const ws = (id: string, name: string, ticket: string | null = null) => ({ id, name, ticket });

describe('parseCommand', () => {
  it('reads each command with its options', () => {
    expect(parseCommand(['list'])).toEqual({ command: 'list' });
    expect(parseCommand(['new', 'PROJ-1'])).toEqual({ command: 'new', body: { name: 'PROJ-1' } });
    expect(parseCommand(['new', 'PROJ-1', '--cwd', '/Users/me/app', '--worktree', 'PROJ-1', '--prompt', 'go', '--url', 'https://a.example/x'])).toEqual({
      command: 'new',
      body: { name: 'PROJ-1', cwd: '/Users/me/app', worktree: 'PROJ-1', prompt: 'go', url: 'https://a.example/x' },
    });
    expect(parseCommand(['new', '--pr', 'https://github.com/acme/app/pull/3'])).toEqual({ command: 'new', body: { pr: 'https://github.com/acme/app/pull/3' } });
    expect(parseCommand(['focus', 'PROJ-1'])).toEqual({ command: 'focus', ref: 'PROJ-1' });
    expect(parseCommand(['send', 'PROJ-1', 'look', 'at', 'this'])).toEqual({ command: 'send', ref: 'PROJ-1', text: 'look at this' });
    expect(parseCommand(['rm', 'ws-0123abcd'])).toEqual({ command: 'rm', ref: 'ws-0123abcd' });
  });

  it('says what is wrong with a command it cannot read', () => {
    expect(parseCommand([])).toEqual({ error: usage });
    expect(parseCommand(['dance'])).toEqual({ error: `Unknown command "dance".\n${usage}` });
    expect(parseCommand(['new'])).toEqual({ error: 'new needs a name, or --pr.' });
    expect(parseCommand(['new', 'x', '--cwd'])).toEqual({ error: '--cwd needs a value.' });
    expect(parseCommand(['new', 'x', '--bogus', 'y'])).toEqual({ error: 'Unknown option "--bogus".' });
    expect(parseCommand(['focus'])).toEqual({ error: 'focus needs a workspace: its id, name or ticket.' });
    expect(parseCommand(['send', 'PROJ-1'])).toEqual({ error: 'send needs text after the workspace.' });
  });
});

describe('findWorkspace', () => {
  const list = [ws('ws-0123abcd', 'Email table', 'PROJ-1'), ws('ws-0123abce', 'proj-2', 'PROJ-2'), ws('ws-0123abcf', 'Other')];
  it('matches an id, then a ticket, then a name, ignoring case', () => {
    expect(findWorkspace(list, 'ws-0123abcf')?.name).toBe('Other');
    expect(findWorkspace(list, 'proj-1')?.name).toBe('Email table');
    expect(findWorkspace(list, 'email table')?.name).toBe('Email table');
    expect(findWorkspace(list, 'PROJ-2')?.id).toBe('ws-0123abce');
    expect(findWorkspace(list, 'nope')).toBeUndefined();
  });
});
