import { execFileSync } from 'node:child_process';

/** Runs git in `cwd` with a committer, so a test repository can commit, and returns its stdout as it is. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
}

/** `git`, with the trailing newline taken off. */
export const gitTrimmed = (cwd: string, ...args: string[]): string => git(cwd, ...args).trim();
