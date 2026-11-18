import { execFileSync } from 'node:child_process';

/** A committer, so a test repository can commit. */
const CONFIG = ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];

/** Runs git in `cwd` as a test committer and returns its stdout as it is. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...CONFIG, ...args], { cwd, encoding: 'utf8' });
}

/** `git`, with the trailing newline taken off. */
export const gitTrimmed = (cwd: string, ...args: string[]): string => git(cwd, ...args).trim();

/**
 * Copies the contents of one folder into another that exists. `cp -R` rather than `fs.cpSync`, which on CI sometimes
 * failed with ENOENT on the copy's own `.git/objects` while the folder it had just made was there.
 */
export function copyTree(from: string, into: string): void {
  execFileSync('cp', ['-R', `${from}/.`, into]);
}
