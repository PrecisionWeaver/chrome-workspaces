import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MONITOR_SESSION } from '../../../shared/protocol/protocol';
import { RESTORED_MARK, ScrollbackStore } from './scrollback-store';
import { SessionManager } from './session';
import { waitFor } from '../../testing/wait-for';

let sessions: SessionManager;

afterEach(() => sessions.killAll());

describe('Session', () => {
  it('replays output and the exit code to a client that attaches after exit', async () => {
    sessions = new SessionManager(10_000);
    const session = sessions.create({ id: 'echo', command: '/bin/sh', args: ['-c', 'printf hello'], cwd: tmpdir() });
    await waitFor(() => session.exited);

    let output = '';
    let exitCode: number | null = null;
    session.attach(
      (data) => (output += data),
      (code) => (exitCode = code),
    );

    expect(output).toContain('hello');
    expect(exitCode).toBe(0);
  });

  it('reports an exit to an attached client when the shell ends by itself', async () => {
    sessions = new SessionManager(10_000);
    const session = sessions.create({ id: 'brief', command: '/bin/sh', args: ['-c', 'sleep 0.1; exit 3'], cwd: tmpdir() });
    let exitCode: number | null = null;
    session.attach(
      () => {},
      (code) => (exitCode = code),
    );
    await waitFor(() => exitCode !== null);
    expect(exitCode).toBe(3);
  });

  it('does not report an exit to a client of a session that is removed on purpose, since a panel reads one as its shell ending and closes', async () => {
    sessions = new SessionManager(10_000);
    const session = sessions.create({ id: 'archived', command: '/bin/cat', args: [], cwd: tmpdir() });
    let exitCode: number | null = null;
    session.attach(
      () => {},
      (code) => (exitCode = code),
    );
    sessions.remove('archived');
    await waitFor(() => session.exited);
    expect(exitCode).toBeNull();
  });

  it('marks saved scrollback as a replay and live output as not', async () => {
    sessions = new SessionManager(10_000);
    const session = sessions.create({ id: 'cat', command: '/bin/cat', args: [], cwd: tmpdir() });
    session.write('first\r');
    let seen = '';
    session.attach(
      (data) => (seen += data),
      () => {},
    );
    await waitFor(() => seen.includes('first'));

    const flags: Array<boolean | undefined> = [];
    session.attach(
      (_data, replay) => flags.push(replay),
      () => {},
    );
    session.write('second\r');
    await waitFor(() => flags.length > 1);

    expect(flags[0]).toBe(true);
    expect(flags[1]).toBeFalsy();
  });

  it('relays input to the process and its output back to attached clients', async () => {
    sessions = new SessionManager(10_000);
    const session = sessions.create({ id: 'cat', command: '/bin/cat', args: [], cwd: tmpdir() });

    let output = '';
    session.attach(
      (data) => (output += data),
      () => {},
    );
    session.write('ping\r');

    await waitFor(() => output.includes('ping'));
  });

  it('stops delivering output after detach', async () => {
    sessions = new SessionManager(10_000);
    const session = sessions.create({ id: 'cat', command: '/bin/cat', args: [], cwd: tmpdir() });

    let output = '';
    const detach = session.attach(
      (data) => (output += data),
      () => {},
    );
    detach();
    // A second listener hears when `cat` has echoed the line, so there is something to compare against.
    let heard = '';
    session.attach(
      (data) => (heard += data),
      () => {},
    );
    session.write('after\r');
    await waitFor(() => heard.includes('after'));

    expect(output).not.toContain('after');
  });

  it('does not leak the launching Claude session into the shell', async () => {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_CHILD_SESSION = 'parent';
    let session: ReturnType<SessionManager['create']>;
    try {
      sessions = new SessionManager(10_000);
      session = sessions.create({
        id: 'env',
        command: '/bin/sh',
        args: ['-c', 'echo "[$CLAUDECODE][$CLAUDE_CODE_CHILD_SESSION][$KEEP_ME]"'],
        cwd: tmpdir(),
        env: { KEEP_ME: 'kept' },
      });
      await waitFor(() => session.exited);
    } finally {
      // A failure above must not leave the parent's variables set for the tests after this one.
      delete process.env.CLAUDECODE;
      delete process.env.CLAUDE_CODE_CHILD_SESSION;
    }

    let output = '';
    session.attach(
      (data) => (output += data),
      () => {},
    );
    expect(output).toContain('[][][kept]');
  });

  it('refuses a duplicate session id', () => {
    sessions = new SessionManager(10_000);
    sessions.create({ id: 'dup', command: '/bin/cat', args: [], cwd: tmpdir() });
    expect(() => sessions.create({ id: 'dup', command: '/bin/cat', args: [], cwd: tmpdir() })).toThrow(/already exists/);
  });

  it('saves running terminals when asked, and starts the next session of that id with what was saved', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cw-saved-')), 'scrollback');
    sessions = new SessionManager(10_000, new ScrollbackStore(dir));
    const cat = sessions.create({ id: 'ws-0123abcd', command: '/bin/cat', args: [], cwd: tmpdir() });
    const done = sessions.create({ id: 'ws-00000002', command: '/bin/sh', args: ['-c', 'printf bye'], cwd: tmpdir() });
    const monitor = sessions.create({ id: MONITOR_SESSION, command: '/bin/cat', args: [], cwd: tmpdir() });
    cat.write('before\r');
    monitor.write('gauges\r');
    await waitFor(() => cat.snapshot().includes('before') && monitor.snapshot().includes('gauges') && done.exited);

    sessions.saveAll();
    // A shell that already exited starts afresh, and the monitor redraws itself.
    expect(readdirSync(dir)).toEqual(['ws-0123abcd.txt']);
    sessions.killAll();

    sessions = new SessionManager(10_000, new ScrollbackStore(dir));
    const next = sessions.create({ id: 'ws-0123abcd', command: '/bin/cat', args: [], cwd: tmpdir() });
    const replayed: string[] = [];
    next.attach(
      (data, replay) => replay && replayed.push(data),
      () => {},
    );
    expect(replayed.join('')).toContain('before');
    expect(replayed.join('').endsWith(RESTORED_MARK)).toBe(true);
    // Read once: the session after this one starts empty.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('forgets the saved scrollback of a session that is removed, and saves nothing without a store', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cw-saved-')), 'scrollback');
    const store = new ScrollbackStore(dir);
    store.save('ws-0123abcd', 'old');
    sessions = new SessionManager(10_000, store);
    sessions.remove('ws-0123abcd');
    expect(readdirSync(dir)).toEqual([]);

    sessions = new SessionManager(10_000);
    sessions.create({ id: 'cat', command: '/bin/cat', args: [], cwd: tmpdir() });
    sessions.saveAll();
    expect(readdirSync(dir)).toEqual([]);
  });
});
