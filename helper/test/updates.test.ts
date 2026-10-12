import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyUpdate, checkUpdates } from '../src/updates';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

/** An origin, a clone that is the installed copy, and a second clone used to publish new commits. */
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cw-upd-'));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  writeFileSync(join(seed, 'a.txt'), '1\n');
  git(seed, 'add', '.');
  git(seed, 'commit', '-qm', 'first');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const installed = join(root, 'installed');
  git(root, 'clone', '-q', origin, installed);
  const publish = (file: string, message: string) => {
    writeFileSync(join(seed, file), `${message}\n`);
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', message);
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
  };
  const release = (tag: string) => {
    git(seed, 'tag', tag);
    git(seed, 'push', '-q', 'origin', tag);
  };
  return { installed, publish, release };
}

const ranAll = (commands: string[]) => async (command: string) => {
  commands.push(command);
  return { output: 'ok', ok: true };
};

describe('checkUpdates', () => {
  it('is up to date with nothing new, and lists what a newer remote brings, newest first', async () => {
    const { installed, publish } = setup();
    expect(await checkUpdates(installed)).toMatchObject({ behind: 0, ahead: 0, canUpdate: false, reason: 'Already up to date.', commits: [] });
    publish('b.txt', 'second change');
    publish('c.txt', 'third change');
    const status = await checkUpdates(installed);
    expect(status).toMatchObject({ behind: 2, ahead: 0, dirty: false, canUpdate: true, reason: null, upstream: 'origin/main', branch: 'main' });
    expect(status.commits.map((c) => c.subject)).toEqual(['third change', 'second change']);
  });

  it('refuses to update over uncommitted changes, and when the copy has commits the remote lacks', async () => {
    const { installed, publish } = setup();
    publish('b.txt', 'remote change');
    writeFileSync(join(installed, 'a.txt'), 'edited locally\n');
    expect(await checkUpdates(installed)).toMatchObject({ behind: 1, dirty: true, canUpdate: false, reason: expect.stringContaining('uncommitted') });

    git(installed, 'checkout', '-q', '--', 'a.txt');
    writeFileSync(join(installed, 'local.txt'), 'mine\n');
    git(installed, 'add', '.');
    git(installed, 'commit', '-qm', 'local commit');
    expect(await checkUpdates(installed)).toMatchObject({ behind: 1, ahead: 1, canUpdate: false, reason: expect.stringContaining('cannot be fast-forwarded') });
  });

  it('goes to the newest release, not to commits made since it', async () => {
    const { installed, publish, release } = setup();
    publish('b.txt', 'released change');
    release('v0.9.0');
    publish('c.txt', 'other change');
    release('v0.10.0');
    release('v0.11.0-beta');
    publish('d.txt', 'unreleased change');
    const status = await checkUpdates(installed);
    expect(status).toMatchObject({ release: 'v0.10.0', behind: 2, ahead: 0, canUpdate: true });
    expect(status.commits.map((c) => c.subject)).toEqual(['other change', 'released change']);
  });

  it('is up to date on a release even with newer unreleased commits checked out', async () => {
    const { installed, publish, release } = setup();
    publish('b.txt', 'released');
    release('v1.0.0');
    publish('c.txt', 'unreleased');
    git(installed, 'pull', '-q', '--ff-only');
    expect(await checkUpdates(installed)).toMatchObject({ release: 'v1.0.0', behind: 0, ahead: 1, canUpdate: false, reason: 'Already up to date.' });
  });

  it('says so when the branch tracks nothing', async () => {
    const { installed } = setup();
    git(installed, 'checkout', '-q', '-b', 'local-only');
    expect(await checkUpdates(installed)).toMatchObject({ upstream: null, canUpdate: false, reason: expect.stringContaining('does not track') });
  });
});

describe('applyUpdate', () => {
  it('fast-forwards and rebuilds, and installs dependencies only when they changed', async () => {
    const { installed, publish } = setup();
    publish('b.txt', 'plain change');
    const commands: string[] = [];
    const outcome = await applyUpdate(installed, ranAll(commands));
    expect(outcome).toMatchObject({ ok: true, restart: true, message: expect.stringContaining('1 commit') });
    expect(existsSync(join(installed, 'b.txt'))).toBe(true);
    expect(commands).toEqual(['npm run build:extension 2>&1 | tail -5']);

    publish('package.json', '{}');
    const again: string[] = [];
    expect(await applyUpdate(installed, ranAll(again))).toMatchObject({ ok: true });
    expect(again).toEqual(['npm install --no-audit --no-fund 2>&1 | tail -5', 'npm run build:extension 2>&1 | tail -5']);
  });

  it('fast-forwards to the release tag and names it', async () => {
    const { installed, publish, release } = setup();
    publish('b.txt', 'released');
    release('v1.2.3');
    publish('c.txt', 'unreleased');
    expect(await applyUpdate(installed, ranAll([]))).toMatchObject({ ok: true, message: expect.stringContaining('→ v1.2.3 (1 commit)') });
    expect(existsSync(join(installed, 'b.txt'))).toBe(true);
    expect(existsSync(join(installed, 'c.txt'))).toBe(false);
  });

  it('does nothing when it is not safe, leaving the copy exactly as it was', async () => {
    const { installed, publish } = setup();
    publish('b.txt', 'remote change');
    writeFileSync(join(installed, 'a.txt'), 'edited locally\n');
    const head = git(installed, 'rev-parse', 'HEAD');
    const commands: string[] = [];
    expect(await applyUpdate(installed, ranAll(commands))).toMatchObject({ ok: false, restart: false, message: expect.stringContaining('uncommitted') });
    expect(git(installed, 'rev-parse', 'HEAD')).toBe(head);
    expect(commands).toEqual([]);
  });

  it('reports a failed install or build without restarting, and a copy already current', async () => {
    const { installed, publish } = setup();
    expect(await applyUpdate(installed, ranAll([]))).toMatchObject({ ok: false, message: 'Already up to date.' });
    publish('b.txt', 'change');
    const failing = async () => ({ output: 'tsc exploded', ok: false });
    expect(await applyUpdate(installed, failing)).toMatchObject({ ok: false, restart: false, message: expect.stringContaining('build failed: tsc exploded') });
  });
});
