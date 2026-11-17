import type { ReviewDecision } from './pull-requests';

// What the source control pane shows of a workspace's repository. Shared by the helper and the extension bundle — keep this free of Node imports.

/** What a git write was: the one-line result carries it so the view knows what just happened. */
export type GitResultAction = 'stage' | 'unstage' | 'discard' | 'commit' | 'switch' | 'push' | 'pr';

/** One changed path in a working tree, as `git status` reports it. */
export interface GitFile {
  path: string;
  /** Status letter in the index (staged), or `?` for untracked; a space when unchanged. */
  index: string;
  /** Status letter in the working tree; a space when unchanged. */
  worktree: string;
  /** Where a renamed or copied file came from. */
  from?: string;
}

export interface GitCommit {
  sha: string;
  short: string;
  author: string;
  /** ISO 8601. */
  date: string;
  /** Branches and tags pointing at it, e.g. `HEAD -> main`, `origin/main`, `tag: v1`. */
  refs: string[];
  parents: string[];
  subject: string;
}

export interface GitState {
  /** The working tree's top directory. */
  root: string;
  /** The name of the linked worktree this is, or null for the main working tree. */
  worktree: string | null;
  /** Null on a detached HEAD. */
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
  commits: GitCommit[];
}

/** The pull request for a workspace's current branch. */
export interface BranchPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  reviewDecision: ReviewDecision | null;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
}

export interface GitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
}

export interface GitCompare {
  /** The branch compared against, e.g. `origin/main`. */
  base: string;
  /** The commit the current branch forked from. */
  mergeBase: string;
  /** Commits on the current branch that the base does not have. */
  ahead: number;
  files: GitCommitFile[];
}

export interface GitCommitFile {
  /** `A`, `M`, `D`, `R`, `C` or `T`. */
  status: string;
  path: string;
  from?: string;
}
