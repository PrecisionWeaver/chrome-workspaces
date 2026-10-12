import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
    const out =
      'a1\x1fa1b\x1fAnn\x1f2026-10-01T00:00:00Z\x1fHEAD -> main, origin/main, tag: v1\x1fp1 p2\x1fFix: a | b\x1e\nc2\x1fc2d\x1fBo\x1f2026-09-30T00:00:00Z\x1f\x1f\x1froot\x1e';
    expect(parseLog(out)).toEqual([
      {
        sha: 'a1',
        short: 'a1b',
        author: 'Ann',
        date: '2026-10-01T00:00:00Z',
        refs: ['HEAD -> main', 'origin/main', 'tag: v1'],
        parents: ['p1', 'p2'],
        subject: 'Fix: a | b',
      },
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

  it("lists a commit's files and diffs a file in it, in the working tree, and untracked", async () => {
    const dir = repo();
    const [latest] = (await service.state(dir)).commits;
    expect(await service.commitFiles(dir, latest.sha)).toEqual([{ status: 'M', path: 'a.txt' }]);
    expect((await service.diff(dir, 'a.txt', latest.sha)).diff).toContain('+two');

    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    expect((await service.diff(dir, 'a.txt', null)).diff).toContain('+three');
    writeFileSync(join(dir, 'new.txt'), 'brand new\n');
    expect((await service.diff(dir, 'new.txt', null)).diff).toContain('+brand new');
  });

  it('reports a linked worktree by name, with its own branch and history, and links it to the main tree', async () => {
    const dir = repo();
    const worktree = join(mkdtempSync(join(tmpdir(), 'cw-wt-')), 'topic-tree');
    git(dir, 'worktree', 'add', '-q', '-b', 'topic', worktree);
    writeFileSync(join(worktree, 'only-here.txt'), 'x\n');
    git(worktree, 'add', '.');
    git(worktree, 'commit', '-qm', 'on topic');

    const main = await service.state(dir);
    expect(main).toMatchObject({ branch: 'main', worktree: null });
    const linked = await service.state(worktree);
    expect(linked).toMatchObject({ branch: 'topic', worktree: 'topic-tree' });
    expect(linked.commits[0].subject).toBe('on topic');
    expect(main.commits.map((c) => c.subject)).not.toContain('on topic');

    expect(await service.sameRepository(dir, worktree)).toBe(true);
    expect(await service.sameRepository(dir, repo())).toBe(false);
    expect(await service.sameRepository(dir, mkdtempSync(join(tmpdir(), 'cw-nogit-')))).toBe(false);
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

describe('git service writes', () => {
  const service = createGitService();
  const names = async (dir: string) => (await service.state(dir)).files.map((f) => `${f.index}${f.worktree} ${f.path}`).sort();

  it('stages, unstages and commits, and refuses to commit with nothing staged or no message', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(dir, 'b.txt'), 'new\n');
    expect(await names(dir)).toEqual([' M a.txt', '?? b.txt']);

    await service.stage(dir, ['a.txt'], true);
    expect(await names(dir)).toEqual(['?? b.txt', 'M  a.txt']);
    await service.stage(dir, [], false);
    expect(await names(dir)).toEqual([' M a.txt', '?? b.txt']);
    await service.stage(dir, [], true);
    expect(await names(dir)).toEqual(['A  b.txt', 'M  a.txt']);

    await expect(service.save(dir, '   ')).rejects.toThrow('message');
    expect(await service.save(dir, 'add b and update a')).toMatch(/^[0-9a-f]{7} add b and update a$/);
    expect(await names(dir)).toEqual([]);
    expect((await service.state(dir)).commits[0].subject).toBe('add b and update a');
    await expect(service.save(dir, 'again')).rejects.toThrow('nothing is staged');
  });

  it('unstages in a repository with no commits, where there is no HEAD to restore from', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-fresh-'));
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'x.txt'), 'x\n');
    await service.stage(dir, ['x.txt'], true);
    expect(await names(dir)).toEqual(['A  x.txt']);
    await service.stage(dir, ['x.txt'], false);
    expect(await names(dir)).toEqual(['?? x.txt']);
    await service.stage(dir, ['x.txt'], true);
    expect(await service.save(dir, 'first')).toMatch(/first$/);
  });

  it('discards a tracked change by restoring it and an untracked file by deleting it, touching nothing else', async () => {
    const dir = repo();
    writeFileSync(join(dir, 'a.txt'), 'changed\n');
    writeFileSync(join(dir, 'junk.txt'), 'junk\n');
    writeFileSync(join(dir, 'keep.txt'), 'keep\n');
    await service.discard(dir, ['a.txt', 'junk.txt']);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(existsSync(join(dir, 'junk.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('keep\n');
    await expect(service.discard(dir, [])).rejects.toThrow('choose');
  });

  it('refuses paths that climb out of the repository, for every write', async () => {
    const dir = repo();
    for (const bad of ['../x', '/etc/passwd', 'a/../../b']) {
      await expect(service.stage(dir, [bad], true)).rejects.toThrow('path');
      await expect(service.discard(dir, [bad])).rejects.toThrow('path');
    }
    await expect(
      service.stage(
        dir,
        Array.from({ length: 501 }, (_, i) => `f${i}`),
        true,
      ),
    ).rejects.toThrow('too many');
  });

  it('lists branches, switches to an existing one only, and refuses names that are not branches', async () => {
    const dir = repo();
    git(dir, 'branch', 'topic');
    const list = await service.branches(dir);
    expect(list.map((b) => [b.name, b.current]).sort()).toEqual([
      ['main', true],
      ['topic', false],
    ]);
    expect(await service.switchBranch(dir, 'topic')).toBe('Switched to topic.');
    expect((await service.state(dir)).branch).toBe('topic');
    await expect(service.switchBranch(dir, 'nonexistent')).rejects.toThrow('no branch');
    await expect(service.switchBranch(dir, '--detach')).rejects.toThrow();
    await expect(service.switchBranch(dir, 'bad name')).rejects.toThrow();
  });

  it("compares a branch with its main line: files, commit count and each file's diff", async () => {
    const dir = repo();
    git(dir, 'switch', '-q', '-c', 'feature');
    writeFileSync(join(dir, 'a.txt'), 'one\ntwo\nthree\n');
    writeFileSync(join(dir, 'new.txt'), 'brand new\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'feature work');
    writeFileSync(join(dir, 'more.txt'), 'more\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'more feature work');

    const result = await service.compare(dir);
    expect(result).toMatchObject({ base: 'main', ahead: 2 });
    expect(result.files.map((f) => `${f.status} ${f.path}`).sort()).toEqual(['A more.txt', 'A new.txt', 'M a.txt']);
    expect((await service.diff(dir, 'a.txt', null, true)).diff).toContain('+three');
    expect((await service.diff(dir, 'new.txt', null, true)).diff).toContain('+brand new');
  });

  it('has nothing to compare with when there is no main line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-nobase-'));
    git(dir, 'init', '-q', '-b', 'trunk');
    writeFileSync(join(dir, 'f'), 'x');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    await expect(service.compare(dir)).rejects.toThrow('no main branch');
  });
});
