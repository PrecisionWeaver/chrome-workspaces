import { execFileSync } from 'node:child_process';

/** A committer, so a test repository can commit, and no background maintenance, which rewrites `.git` while a test copies it. */
const CONFIG = ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', '-c', 'maintenance.auto=false', '-c', 'gc.auto=0'];

/** Runs git in `cwd` as a test committer and returns its stdout as it is. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...CONFIG, ...args], { cwd, encoding: 'utf8' });
}

/** `git`, with the trailing newline taken off. */
export const gitTrimmed = (cwd: string, ...args: string[]): string => git(cwd, ...args).trim();
