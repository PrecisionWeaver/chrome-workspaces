import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createGitService, parseLog, parseNameStatus, parseStatus } from '../src/git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-git-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'first');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  git(dir, 'commit', '-qam', 'second: add two');
  return dir;
}

describe('parseStatus', () => {
  it('reads branch, upstream, counts and files, including a rename and a space in a path', () => {
    const out = ['## main...origin/main [ahead 2, behind 1]', ' M src/a.ts', 'A  new file.ts', '?? notes.md', 'R  to.ts', 'from.ts', ''].join('\0');
    expect(parseStatus(out)).toEqual({
      branch: 'main',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      files: [
        { index: ' ', worktree: 'M', path: 'src/a.ts' },
        { index: 'A', worktree: ' ', path: 'new file.ts' },
        { index: '?', worktree: '?', path: 'notes.md' },
        { index: 'R', worktree: ' ', path: 'to.ts', from: 'from.ts' },
      ],
    });
  });

  it('reads a branch with no upstream, no commits yet, and a detached head', () => {
    expect(parseStatus('## topic\0')).toMatchObject({ branch: 'topic', upstream: null, ahead: 0, behind: 0 });
    expect(parseStatus('## No commits yet on main\0')).toMatchObject({ branch: 'main', upstream: null });
    expect(parseStatus('## HEAD (no branch)\0')).toMatchObject({ branch: null });
  });
});

describe('parseLog and parseNameStatus', () => {
  it('splits commits, their refs and parents', () => {
    const out = 'a1\x1fa1b\x1fAnn\x1f2026-10-01T00:00:00Z\x1fHEAD -> main, origin/main, tag: v1\x1fp1 p2\x1fFix: a | b\x1e\nc2\x1fc2d\x1fBo\x1f2026-09-30T00:00:00Z\x1f\x1f\x1froot\x1e';
    expect(parseLog(out)).toEqual([
      { sha: 'a1', short: 'a1b', author: 'Ann', date: '2026-10-01T00:00:00Z', refs: ['HEAD -> main', 'origin/main', 'tag: v1'], parents: ['p1', 'p2'], subject: 'Fix: a | b' },
      { sha: 'c2', short: 'c2d', author: 'Bo', date: '2026-09-30T00:00:00Z', refs: [], parents: [], subject: 'root' },
    ]);
  });

  it('reads name-status entries, with a rename carrying both paths', () => {
    expect(parseNameStatus(['M', 'a.ts', 'R100', 'old.ts', 'new.ts', 'D', 'gone.ts', ''].join('\0'))).toEqual([
      { status: 'M', path: 'a.ts' },
      { status: 'R', from: 'old.ts', path: 'new.ts' },
      { status: 'D', path: 'gone.ts' },
    ]);
  });
});

describe('git service', () => {
  const service = createGitService();

  it('reports status and history of a real repository', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(dir, 'b.txt'), 'new\n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'c.txt'), 'c\n');
    const state = await service.state(dir);
    expect(state.branch).toBe('main');
    expect(state.commits.map((c) => c.subject)).toEqual(['second: add two', 'first']);
    expect(state.commits[0].refs).toContain('HEAD -> main');
    expect(state.files.map((f) => `${f.index}${f.worktree} ${f.path}`).sort()).toEqual([' M a.txt', '?? b.txt', '?? sub/c.txt']);
  });

  it('lists a commit\'s files and diffs a file in it, in the working tree, and untracked', async () => {
    const dir = repo();
    const [latest] = (await service.state(dir)).commits;
    expect(await service.commitFiles(dir, latest.sha)).toEqual([{ status: 'M', path: 'a.txt' }]);
    expect((await service.diff(dir, 'a.txt', latest.sha)).diff).toContain('+two');

    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    expect((await service.diff(dir, 'a.txt', null)).diff).toContain('+three');
    writeFileSync(join(dir, 'new.txt'), 'brand new\n');
    expect((await service.diff(dir, 'new.txt', null)).diff).toContain('+brand new');
  });

  it('refuses paths and ids that could reach outside or inject arguments', async () => {
    const dir = repo();
    await expect(service.diff(dir, '../../etc/passwd', null)).rejects.toThrow('path');
    await expect(service.diff(dir, '/etc/passwd', null)).rejects.toThrow('path');
    await expect(service.diff(dir, 'a.txt', '--output=/tmp/x')).rejects.toThrow('commit id');
    await expect(service.commitFiles(dir, 'HEAD; rm -rf')).rejects.toThrow('commit id');
  });

  it('rejects a directory that is not a repository, and handles one with no commits', async () => {
    await expect(service.state(mkdtempSync(join(tmpdir(), 'cw-nogit-')))).rejects.toThrow();
    const empty = mkdtempSync(join(tmpdir(), 'cw-empty-'));
    git(empty, 'init', '-q', '-b', 'main');
    writeFileSync(join(empty, 'x.txt'), 'x\n');
    git(empty, 'add', 'x.txt');
    expect(await service.state(empty)).toMatchObject({ branch: 'main', commits: [], files: [{ index: 'A', worktree: ' ', path: 'x.txt' }] });
    expect((await service.diff(empty, 'x.txt', null)).diff).toContain('+x');
  });
});
