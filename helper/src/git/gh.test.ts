import { describe, expect, it, vi } from 'vitest';
import { createGh, type Exec, newPullRequestUrl } from './gh';

const failing = (over: { stdout?: string; stderr?: string; message?: string }) => Object.assign(new Error(over.message ?? 'Command failed'), over);

describe('createGh', () => {
  it('runs the command through a login shell and returns its stdout', async () => {
    const exec = vi.fn<Exec>(async () => ({ stdout: 'out' }));
    expect(await createGh('/bin/zsh', exec)('gh pr list')).toBe('out');
    expect(exec).toHaveBeenCalledWith('/bin/zsh', ['-l', '-c', 'gh pr list'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  });

  it('passes the directory, limits and extra environment through', async () => {
    const exec = vi.fn<Exec>(async () => ({ stdout: '' }));
    await createGh('sh', exec)('gh x', { cwd: '/repo', timeoutMs: 60_000, maxBufferBytes: 1024, env: { CW_QUERY: 'q' } });
    const options = exec.mock.calls[0][2];
    expect(options).toMatchObject({ cwd: '/repo', timeout: 60_000, maxBuffer: 1024 });
    expect(options.env?.CW_QUERY).toBe('q');
    expect(options.env?.PATH).toBe(process.env.PATH);
  });

  it('rethrows the exec error as it is by default', async () => {
    const error = failing({ stderr: 'boom' });
    await expect(createGh('sh', async () => Promise.reject(error))('gh x')).rejects.toBe(error);
  });

  it('keeps what gh printed when it exits non-zero, if asked to, and still fails without any', async () => {
    const gh = (over: Parameters<typeof failing>[0]) => createGh('sh', async () => Promise.reject(failing(over)));
    expect(await gh({ stdout: '{"data":1}' })('gh x', { keepStdout: true })).toBe('{"data":1}');
    await expect(gh({ stdout: '' })('gh x', { keepStdout: true })).rejects.toThrow('Command failed');
    await expect(gh({ stdout: '{"data":1}' })('gh x')).rejects.toThrow('Command failed');
  });

  it("fails with gh's own words when asked to: its stderr, or its last line", async () => {
    const gh = createGh('sh', async () => Promise.reject(failing({ stderr: ' warning\nno such branch \n' })));
    await expect(gh('gh x', { stderrAs: 'message' })).rejects.toThrow('warning\nno such branch');
    await expect(gh('gh x', { stderrAs: 'last-line' })).rejects.toThrow(/^no such branch$/);
    const silent = createGh('sh', async () => Promise.reject(failing({ stderr: '', message: 'timed out' })));
    await expect(silent('gh x', { stderrAs: 'message' })).rejects.toThrow('timed out');
  });
});

describe('newPullRequestUrl', () => {
  it('takes the last line, which is where gh puts the url', () => {
    expect(newPullRequestUrl('Creating pull request for x into main\n\nhttps://github.com/acme/app/pull/42\n')).toBe('https://github.com/acme/app/pull/42');
  });

  it('refuses output that does not end in a pull request url', () => {
    expect(() => newPullRequestUrl('')).toThrow('no output');
    expect(() => newPullRequestUrl('https://github.com/acme/app/pull/42\ndone')).toThrow('gh did not say where the pull request is: done');
    expect(() => newPullRequestUrl('http://example.com/pull/1')).toThrow();
  });
});
