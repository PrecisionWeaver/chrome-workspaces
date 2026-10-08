import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Repo } from '../../shared/protocol';
import { isDirectory } from './config';

/** Git repos directly inside each root; a worktree counts, since its `.git` is a file. Read on every request. */
export function listRepos(roots: readonly string[]): Repo[] {
  const repos: Repo[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of entries) {
      const path = join(root, name);
      if (isDirectory(path) && existsSync(join(path, '.git'))) repos.push({ name, path, root: basename(root) });
    }
  }
  return repos.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
}
