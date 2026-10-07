import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../src/session';
import { waitFor } from './wait-for';

let sessions: SessionManager;

afterEach(() => sessions.killAll());

describe('Session', () => {
  it('replays output and the exit code to a client that attaches after exit', async () => {
    sessions = new SessionManager(10_000);
    const session = sessions.create({ id: 'echo', command: '/bin/sh', args: ['-c', 'printf hello'], cwd: tmpdir() });
    await waitFor(() => session.exited);

    let output = '';
    let exitCode: number | null = null;
    session.attach((data) => (output += data), (code) => (exitCode = code));

    expect(output).toContain('hello');
    expect(exitCode).toBe(0);
  });

  it('relays input to the process and its output back to attached clients', async () => {
    sessions = new SessionManager(10_000);
    const session = sessions.create({ id: 'cat', command: '/bin/cat', args: [], cwd: tmpdir() });

    let output = '';
    session.attach((data) => (output += data), () => {});
    session.write('ping\r');

    await waitFor(() => output.includes('ping'));
  });

  it('stops delivering output after detach', async () => {
    sessions = new SessionManager(10_000);
    const session = sessions.create({ id: 'cat', command: '/bin/cat', args: [], cwd: tmpdir() });

    let output = '';
    const detach = session.attach((data) => (output += data), () => {});
    detach();
    session.write('after\r');
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(output).not.toContain('after');
  });

  it('does not leak the launching Claude session into the shell', async () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_CHILD_SESSION = 'parent';
    sessions = new SessionManager(10_000);
    const session = sessions.create({
      id: 'env',
      command: '/bin/sh',
      args: ['-c', 'echo "[$CLAUDECODE][$CLAUDE_CODE_CHILD_SESSION][$KEEP_ME]"'],
      cwd: tmpdir(),
      env: { KEEP_ME: 'kept' },
    });
    await waitFor(() => session.exited);
    delete process.env.CLAUDECODE;
    delete process.env.CLAUDE_CODE_CHILD_SESSION;

    let output = '';
    session.attach((data) => (output += data), () => {});
    expect(output).toContain('[][][kept]');
  });

  it('refuses a duplicate session id', () => {
    sessions = new SessionManager(10_000);
    sessions.create({ id: 'dup', command: '/bin/cat', args: [], cwd: tmpdir() });
    expect(() => sessions.create({ id: 'dup', command: '/bin/cat', args: [], cwd: tmpdir() })).toThrow(/already exists/);
  });
});
