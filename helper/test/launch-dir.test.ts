import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { launchDirectory } from '../src/launch-dir';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

const made: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function repoWithWorktree() {
  const repo = temp('cw-launch-');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  const worktree = join(temp('cw-launch-wt-'), 'topic-tree');
  git(repo, 'worktree', 'add', '-q', worktree, '-b', 'topic');
  return { repo, worktree };
}

describe('launchDirectory', () => {
  it('starts in the worktree claude was last working in', () => {
    const { repo, worktree } = repoWithWorktree();
    expect(launchDirectory(repo, worktree)).toBe(worktree);
  });

  it("starts in the workspace's own directory when claude was not anywhere else", () => {
    const { repo } = repoWithWorktree();
    expect(launchDirectory(repo, null)).toBe(repo);
    expect(launchDirectory(repo, repo)).toBe(repo);
  });

  it('falls back when the worktree has since been removed', () => {
    const { repo, worktree } = repoWithWorktree();
    git(repo, 'worktree', 'remove', '--force', worktree);
    expect(launchDirectory(repo, worktree)).toBe(repo);
  });

  it('ignores a directory that is another repository, not a relative path, or not a repository at all', () => {
    const { repo } = repoWithWorktree();
    const other = temp('cw-launch-other-');
    git(other, 'init', '-q');
    expect(launchDirectory(repo, other)).toBe(repo);
    expect(launchDirectory(repo, 'relative/dir')).toBe(repo);
    expect(launchDirectory(repo, temp('cw-launch-nogit-'))).toBe(repo);
  });
});
