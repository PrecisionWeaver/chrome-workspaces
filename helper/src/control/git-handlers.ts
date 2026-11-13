import { isAbsolute } from 'node:path';
import type { WebSocket } from 'ws';
import type { ControlToClient, ControlToHelper, Workspace } from '../../../shared/protocol/protocol';
import { parseBranchChecks } from '../git/pr-details';
import { isDirectory } from '../platform/config';
import type { HubContext } from './hub';

export type GitRequest = Extract<
  ControlToHelper,
  {
    type:
      | 'git'
      | 'gitCommit'
      | 'gitDiff'
      | 'gitBranches'
      | 'gitChecks'
      | 'gitCompare'
      | 'gitStage'
      | 'gitDiscard'
      | 'gitSave'
      | 'gitSwitch'
      | 'gitPush'
      | 'gitCreatePr';
  }
>;

const GIT_REQUESTS: ReadonlySet<string> = new Set([
  'git',
  'gitCommit',
  'gitDiff',
  'gitBranches',
  'gitChecks',
  'gitCompare',
  'gitStage',
  'gitDiscard',
  'gitSave',
  'gitSwitch',
  'gitPush',
  'gitCreatePr',
]);

export function isGitRequest(message: ControlToHelper): message is GitRequest {
  return GIT_REQUESTS.has(message.type);
}

/**
 * Where to run git for a workspace: the directory its claude reports, when that is another worktree
 * of the same repository (claude moves into worktrees on its own), else the workspace's own.
 */
export async function gitDirectory(hub: HubContext, workspace: Workspace): Promise<string> {
  const reported = hub.options.workingDir(workspace.id);
  if (!reported || reported === workspace.cwd || !isAbsolute(reported) || !isDirectory(reported)) return workspace.cwd;
  return (await hub.options.git.sameRepository(workspace.cwd, reported)) ? reported : workspace.cwd;
}

/**
 * Answers a git request for a workspace's directory; the reply goes to the asking client only. Each request
 * has one shape for its answer and one for its failure, and `answer` fills whichever the work ends in.
 */
export function handleGit(hub: HubContext, message: GitRequest, ws: WebSocket): void {
  const { store, git } = hub.options;
  const { id } = message;
  const workspace = store.get(id);
  const dir = workspace ? gitDirectory(hub, workspace) : Promise.reject(new Error('unknown workspace'));
  const answer = <T>(work: (cwd: string) => Promise<T>, ok: (value: T) => ControlToClient, fail: (reason: string) => ControlToClient) =>
    hub.answer(ws, dir.then(work), ok, fail);
  // A write answers with a one-line result; the work resolves to the message, or to it with a url to open.
  const result = (action: string, work: (cwd: string) => Promise<string | { message: string; url: string }>) =>
    answer(
      work,
      (done) => ({ type: 'gitResult', id, action, ok: true, ...(typeof done === 'string' ? { message: done } : done) }),
      (reason) => ({ type: 'gitResult', id, action, ok: false, message: reason }),
    );

  switch (message.type) {
    case 'git':
      answer(
        (cwd) => git.state(cwd),
        (state) => ({ type: 'git', id, state, error: null }),
        (error) => ({ type: 'git', id, state: null, error }),
      );
      break;
    case 'gitCommit': {
      const { sha } = message;
      answer(
        (cwd) => git.commitFiles(cwd, sha),
        (files) => ({ type: 'gitCommit', id, sha, files, error: null }),
        (error) => ({ type: 'gitCommit', id, sha, files: [], error }),
      );
      break;
    }
    case 'gitDiff': {
      const { path } = message;
      const sha = message.sha ?? null;
      answer(
        (cwd) => git.diff(cwd, path, sha, message.base === true),
        ({ diff, truncated }) => ({ type: 'gitDiff', id, path, sha, diff, truncated, error: null }),
        (error) => ({ type: 'gitDiff', id, path, sha, diff: '', truncated: false, error }),
      );
      break;
    }
    case 'gitChecks':
      answer(
        (cwd) => hub.options.branchPr(cwd),
        (json) => {
          const found = parseBranchChecks(json);
          return { type: 'gitChecks', id, pr: found?.pr ?? null, checks: found?.checks ?? null, error: null };
        },
        // `gh` exits non-zero both for "no pull request" and for a real failure; only the first is not an error.
        (reason) => ({ type: 'gitChecks', id, pr: null, checks: null, error: /no pull requests? found/i.test(reason) ? null : reason.split('\n')[0] }),
      );
      break;
    case 'gitBranches':
      answer(
        (cwd) => git.branches(cwd),
        (branches) => ({ type: 'gitBranches', id, branches, error: null }),
        (error) => ({ type: 'gitBranches', id, branches: [], error }),
      );
      break;
    case 'gitCompare':
      answer(
        (cwd) => git.compare(cwd),
        (compare) => ({ type: 'gitCompare', id, compare, error: null }),
        (error) => ({ type: 'gitCompare', id, compare: null, error }),
      );
      break;
    case 'gitStage':
      result(message.stage ? 'stage' : 'unstage', (cwd) => git.stage(cwd, message.paths, message.stage));
      break;
    case 'gitDiscard':
      result('discard', (cwd) => git.discard(cwd, message.paths));
      break;
    case 'gitSave':
      result('commit', (cwd) => git.save(cwd, message.message));
      break;
    case 'gitSwitch':
      result('switch', (cwd) => git.switchBranch(cwd, message.branch));
      break;
    case 'gitPush':
      result('push', (cwd) => git.push(cwd));
      break;
    case 'gitCreatePr':
      result('pr', async (cwd) => {
        await git.push(cwd);
        const url = await hub.options.createPr(cwd);
        return { message: `Opened ${url}`, url };
      });
      break;
  }
}
