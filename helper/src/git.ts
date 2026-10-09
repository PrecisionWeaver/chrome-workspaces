import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { GitBranch, GitCommit, GitCommitFile, GitCompare, GitFile, GitState } from '../../shared/protocol';

const execFileAsync = promisify(execFile);

const LOG_LIMIT = 80;
const DIFF_LIMIT = 400_000;
const TIMEOUT_MS = 15_000;

export interface GitService {
  /** Whether both directories belong to one repository, as the main tree and its linked worktrees do. */
  sameRepository(a: string, b: string): Promise<boolean>;
  /** Rejects when `cwd` is not inside a git repository. */
  state(cwd: string): Promise<GitState>;
  commitFiles(cwd: string, sha: string): Promise<GitCommitFile[]>;
  /** A file's diff against HEAD, or its change in commit `sha`. */
  diff(cwd: string, path: string, sha: string | null, base?: boolean): Promise<{ diff: string; truncated: boolean }>;
  /** Stages or unstages the paths, or everything when there are none. */
  stage(cwd: string, paths: string[], stage: boolean): Promise<string>;
  /** Discards working-tree changes: tracked files are restored, untracked ones deleted. */
  discard(cwd: string, paths: string[]): Promise<string>;
  /** Commits what is staged and returns the new commit's short id and subject. */
  save(cwd: string, message: string): Promise<string>;
  branches(cwd: string): Promise<GitBranch[]>;
  /** Switches to an existing local branch. */
  switchBranch(cwd: string, branch: string): Promise<string>;
  /** What the current branch changes since it forked from the repository's main line. */
  compare(cwd: string): Promise<GitCompare>;
}

interface Ran {
  stdout: string;
  /** Exit code; `git diff --no-index` exits 1 when the files differ. */
  code: number;
}

async function run(cwd: string, args: string[], acceptCodes: readonly number[] = [0], timeoutMs = TIMEOUT_MS): Promise<Ran> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: timeoutMs,
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
export function parseStatus(output: string): Omit<GitState, 'commits' | 'root' | 'worktree'> {
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

interface Locations {
  root: string;
  gitDir: string;
  commonDir: string;
}

/** Where a directory's working tree, git directory, and the git directory shared by every worktree are. */
async function locate(cwd: string): Promise<Locations> {
  const { stdout } = await run(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir']);
  const [root, gitDir, commonDir] = stdout.trim().split('\n');
  if (!root || !gitDir || !commonDir) throw new Error('not a git repository');
  return { root, gitDir, commonDir };
}

const MAX_PATHS = 500;
const COMMIT_TIMEOUT_MS = 120_000;
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'origin/develop', 'main', 'master', 'develop'];

/** The main line a branch is compared against: the remote's default branch, else a conventional name. */
async function findBase(cwd: string): Promise<string> {
  const head = await run(cwd, ['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD'], [0, 1]).catch(() => null);
  const candidates = [head?.stdout.trim(), ...BASE_CANDIDATES].filter((ref): ref is string => !!ref);
  for (const ref of candidates) {
    const found = await run(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], [0, 1]).catch(() => null);
    if (found?.code === 0) return ref;
  }
  throw new Error('no main branch to compare against');
}

function repoPaths(paths: readonly string[]): string[] {
  if (paths.length > MAX_PATHS) throw new Error('too many files at once');
  for (const path of paths) if (!isRepoPath(path)) throw new Error('not a path in the repository');
  return [...paths];
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

export function createGitService(): GitService {
  const inFlight = new Map<string, Promise<GitState>>();

  async function readState(cwd: string): Promise<GitState> {
    const status = run(cwd, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all']);
    // A repository with no commits yet has no log.
    const log = run(cwd, ['log', '-n', String(LOG_LIMIT), '--topo-order', `--format=${LOG_FORMAT}`, '--decorate=short']).catch(() => ({ stdout: '', code: 0 }));
    const [s, l, where] = await Promise.all([status, log, locate(cwd)]);
    // A linked worktree's git directory differs from the one every worktree shares.
    const linked = real(where.gitDir) !== real(where.commonDir);
    return { ...parseStatus(s.stdout), root: where.root, worktree: linked ? basename(where.root) : null, commits: parseLog(l.stdout) };
  }

  return {
    async sameRepository(a, b) {
      try {
        const [first, second] = await Promise.all([locate(a), locate(b)]);
        return real(first.commonDir) === real(second.commonDir);
      } catch {
        return false;
      }
    },

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

    async diff(cwd, path, sha, base = false) {
      if (!isRepoPath(path)) throw new Error('not a path in the repository');
      if (base) {
        const mergeBase = (await run(cwd, ['merge-base', await findBase(cwd), 'HEAD'])).stdout.trim();
        return cap((await run(cwd, ['diff', '--no-color', '--find-renames', mergeBase, 'HEAD', '--', path])).stdout);
      }
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

    async stage(cwd, paths, stage) {
      const list = repoPaths(paths);
      const scope = list.length ? list : ['.'];
      if (stage) {
        await run(cwd, list.length ? ['add', '--', ...scope] : ['add', '-A']);
        return `Staged ${list.length ? `${list.length} file${list.length === 1 ? '' : 's'}` : 'everything'}.`;
      }
      try {
        await run(cwd, ['restore', '--staged', '--', ...scope]);
      } catch {
        // A repository with no commits has no HEAD to restore from; removing from the index is the same.
        await run(cwd, ['rm', '--cached', '-r', '-q', '--', ...scope]);
      }
      return `Unstaged ${list.length ? `${list.length} file${list.length === 1 ? '' : 's'}` : 'everything'}.`;
    },

    async discard(cwd, paths) {
      const list = repoPaths(paths);
      if (list.length === 0) throw new Error('choose which files to discard');
      for (const path of list) {
        const tracked = (await run(cwd, ['ls-files', '--error-unmatch', '--', path], [0, 1]).catch(() => ({ stdout: '', code: 1 }))).code === 0;
        // `clean` only removes untracked files, and `restore` only touches tracked ones, so neither can reach the other's.
        if (tracked) await run(cwd, ['restore', '--', path]);
        else await run(cwd, ['clean', '-f', '-q', '--', path]);
      }
      return `Discarded ${list.length} file${list.length === 1 ? '' : 's'}.`;
    },

    async save(cwd, message) {
      const text = message.trim();
      if (!text) throw new Error('write a commit message first');
      if (text.length > 10_000) throw new Error('that commit message is too long');
      // `diff --cached --quiet` exits 1 when something is staged, and compares with an empty tree before the first commit.
      if ((await run(cwd, ['diff', '--cached', '--quiet'], [0, 1])).code === 0) throw new Error('nothing is staged');
      // Hooks run, so it can take a while; an editor is never opened.
      await run(cwd, ['-c', 'core.editor=true', 'commit', '-q', '-m', text], [0], COMMIT_TIMEOUT_MS);
      return (await run(cwd, ['log', '-1', '--format=%h %s'])).stdout.trim();
    },

    async branches(cwd) {
      const { stdout } = await run(cwd, ['for-each-ref', '--format=%(refname:short)%09%(HEAD)%09%(upstream:short)', '--sort=-committerdate', 'refs/heads']);
      return stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [name, head, upstream] = line.split('\t');
          return { name, current: head === '*', upstream: upstream || null };
        });
    },

    async switchBranch(cwd, branch) {
      await run(cwd, ['check-ref-format', '--branch', branch]);
      // Only a branch that already exists: this switches, it never creates.
      if (!(await this.branches(cwd)).some((b) => b.name === branch)) throw new Error(`no branch named ${branch}`);
      await run(cwd, ['switch', '-q', branch], [0], COMMIT_TIMEOUT_MS);
      return `Switched to ${branch}.`;
    },

    async compare(cwd) {
      const base = await findBase(cwd);
      const mergeBase = (await run(cwd, ['merge-base', base, 'HEAD'])).stdout.trim();
      const [files, ahead] = await Promise.all([
        run(cwd, ['diff', '--name-status', '--find-renames', '-z', mergeBase, 'HEAD']),
        run(cwd, ['rev-list', '--count', `${mergeBase}..HEAD`]),
      ]);
      return { base, mergeBase: mergeBase.slice(0, 7), ahead: Number(ahead.stdout.trim()) || 0, files: parseNameStatus(files.stdout) };
    },
  };
}
