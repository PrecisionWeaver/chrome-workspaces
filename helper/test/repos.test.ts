import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listRepos } from '../src/repos';

function root(name: string, entries: Record<string, 'repo' | 'worktree' | 'plain' | 'file'>): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'cw-repos-')), name);
  mkdirSync(dir);
  for (const [entry, kind] of Object.entries(entries)) {
    const path = join(dir, entry);
    if (kind === 'file') writeFileSync(path, '');
    else mkdirSync(path);
    if (kind === 'repo') mkdirSync(join(path, '.git'));
    if (kind === 'worktree') writeFileSync(join(path, '.git'), 'gitdir: /elsewhere');
  }
  return dir;
}

describe('listRepos', () => {
  it('lists directories holding a .git, worktrees included, and skips the rest', () => {
    const websites = root('Websites', { b: 'repo', a: 'worktree', plain: 'plain', notes: 'file' });
    expect(listRepos([websites])).toEqual([
      { name: 'a', path: join(websites, 'a'), root: 'Websites' },
      { name: 'b', path: join(websites, 'b'), root: 'Websites' },
    ]);
  });

  it('merges roots in name order and skips a root that does not exist', () => {
    const websites = root('Websites', { zed: 'repo', same: 'repo' });
    const herd = root('Herd', { alpha: 'repo', same: 'repo' });
    const repos = listRepos([websites, join(herd, 'missing'), herd]);
    expect(repos.map((r) => `${r.root}/${r.name}`)).toEqual(['Herd/alpha', 'Herd/same', 'Websites/same', 'Websites/zed']);
  });
});
