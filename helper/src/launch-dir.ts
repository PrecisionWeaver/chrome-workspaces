import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { isDirectory } from './config';

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The git directory every worktree of a repository shares, or null when `dir` is not in one. */
function commonDir(dir: string): string | null {
  try {
    return real(
      execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
  } catch {
    return null;
  }
}

/**
 * Where to start a workspace's shell when it resumes a conversation: the worktree claude was last working in
 * (`lastDir`, from its transcript), if that is still there and belongs to the workspace's repository, else the
 * workspace's own directory. Claude moves into worktrees on its own, and resuming from the repository's main
 * directory would otherwise leave it there. Synchronous, because the terminal attaches as soon as it starts.
 */
export function launchDirectory(workspaceCwd: string, lastDir: string | null): string {
  if (!lastDir || lastDir === workspaceCwd || !isAbsolute(lastDir) || !isDirectory(lastDir)) return workspaceCwd;
  const home = commonDir(workspaceCwd);
  return home !== null && home === commonDir(lastDir) ? lastDir : workspaceCwd;
}
