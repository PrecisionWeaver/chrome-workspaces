import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import type { GitCommit, GitCommitFile, GitFile, GitState } from '../../shared/protocol';

const execFileAsync = promisify(execFile);

const LOG_LIMIT = 80;
const DIFF_LIMIT = 400_000;
const TIMEOUT_MS = 15_000;

export interface GitService {
  /** Rejects when `cwd` is not inside a git repository. */
  state(cwd: string): Promise<GitState>;
  commitFiles(cwd: string, sha: string): Promise<GitCommitFile[]>;
  /** A file's diff against HEAD, or its change in commit `sha`. */
  diff(cwd: string, path: string, sha: string | null): Promise<{ diff: string; truncated: boolean }>;
}

interface Ran {
  stdout: string;
  /** Exit code; `git diff --no-index` exits 1 when the files differ. */
  code: number;
}

async function run(cwd: string, args: string[], acceptCodes: readonly number[] = [0]): Promise<Ran> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      // Optional locks off, so polling never blocks the index lock the model's own git commands need.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
    return { stdout, code: 0 };
  } catch (error) {
    const { stdout, stderr, code } = error as { stdout?: string; stderr?: string; code?: number };
    if (typeof code === 'number' && acceptCodes.includes(code)) return { stdout: stdout ?? '', code };
    throw new Error((stderr ?? '').trim().split('\n')[0] || (error instanceof Error ? error.message : String(error)));
  }
}

/** Parses `git status --porcelain=v1 -z --branch`. */
export function parseStatus(output: string): Omit<GitState, 'commits'> {
  const tokens = output.split('\0');
  const header = tokens.shift() ?? '';
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  if (header.startsWith('## ')) {
    let rest = header.slice(3);
    const counts = rest.match(/ \[(.*)\]$/);
    if (counts) {
      rest = rest.slice(0, counts.index);
      ahead = Number(counts[1].match(/ahead (\d+)/)?.[1] ?? 0);
      behind = Number(counts[1].match(/behind (\d+)/)?.[1] ?? 0);
    }
    const unborn = rest.match(/^No commits yet on (.+)$/);
    if (unborn) branch = unborn[1];
    else if (rest.startsWith('HEAD (no branch)')) branch = null;
    else {
      const [name, remote] = rest.split('...');
      branch = name;
      upstream = remote ?? null;
    }
  }

  const files: GitFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    const file: GitFile = { index: entry[0], worktree: entry[1], path: entry.slice(3) };
    // A rename or copy is followed by the path it came from.
    if (/[RC]/.test(file.index + file.worktree)) file.from = tokens[++i];
    files.push(file);
  }
  return { branch, upstream, ahead, behind, files };
}

const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%aI%x1f%D%x1f%P%x1f%s%x1e';

export function parseLog(output: string): GitCommit[] {
  return output
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter(Boolean)
    .map((record) => {
      const [sha, short, author, date, refs, parents, subject] = record.split('\x1f');
      return {
        sha,
        short,
        author,
        date,
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        parents: parents ? parents.split(' ') : [],
        subject: subject ?? '',
      };
    });
}

/** Parses `git show --name-status -z`. */
export function parseNameStatus(output: string): GitCommitFile[] {
  const tokens = output.split('\0').filter(Boolean);
  const files: GitCommitFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i][0];
    if (status === 'R' || status === 'C') {
      files.push({ status, from: tokens[i + 1], path: tokens[i + 2] });
      i += 2;
    } else {
      files.push({ status, path: tokens[i + 1] });
      i += 1;
    }
  }
  return files;
}

/** A path inside the repository: relative, and never climbing out of it. */
function isRepoPath(path: string): boolean {
  return path.length > 0 && !path.includes('\0') && !isAbsolute(path) && !path.split('/').includes('..');
}

const SHA = /^[0-9a-f]{7,40}$/;

function cap(text: string): { diff: string; truncated: boolean } {
  return text.length > DIFF_LIMIT ? { diff: text.slice(0, DIFF_LIMIT), truncated: true } : { diff: text, truncated: false };
}

export function createGitService(): GitService {
  const inFlight = new Map<string, Promise<GitState>>();

  async function readState(cwd: string): Promise<GitState> {
    const status = run(cwd, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
    // A repository with no commits yet has no log.
    const log = run(cwd, ['log', '-n', String(LOG_LIMIT), '--topo-order', `--format=${LOG_FORMAT}`, '--decorate=short']).catch(() => ({ stdout: '', code: 0 }));
    const [s, l] = await Promise.all([status, log]);
    return { ...parseStatus(s.stdout), commits: parseLog(l.stdout) };
  }

  return {
    // Polling asks again before the last answer is back on a big repository; share the run.
    state(cwd) {
      const running = inFlight.get(cwd);
      if (running) return running;
      const next = readState(cwd).finally(() => inFlight.delete(cwd));
      inFlight.set(cwd, next);
      return next;
    },

    async commitFiles(cwd, sha) {
      if (!SHA.test(sha)) throw new Error('not a commit id');
      const { stdout } = await run(cwd, ['show', '--name-status', '--format=', '--find-renames', '-z', sha, '--']);
      return parseNameStatus(stdout);
    },

    async diff(cwd, path, sha) {
      if (!isRepoPath(path)) throw new Error('not a path in the repository');
      if (sha !== null) {
        if (!SHA.test(sha)) throw new Error('not a commit id');
        return cap((await run(cwd, ['show', '--no-color', '--format=', '--find-renames', sha, '--', path])).stdout);
      }
      const tracked = (await run(cwd, ['ls-files', '--error-unmatch', '--', path], [0, 1]).catch(() => ({ stdout: '', code: 1 }))).code === 0;
      if (tracked) {
        // Staged and unstaged together; a repository with no commits has no HEAD to compare to.
        const head = await run(cwd, ['diff', '--no-color', 'HEAD', '--', path], [0, 128]).catch(() => null);
        if (head && head.stdout) return cap(head.stdout);
        return cap((await run(cwd, ['diff', '--no-color', '--cached', '--', path])).stdout);
      }
      // Untracked: shown whole, as an addition. Exit code 1 only means the files differ.
      return cap((await run(cwd, ['diff', '--no-color', '--no-index', '--', '/dev/null', path], [0, 1])).stdout);
    },
  };
}
