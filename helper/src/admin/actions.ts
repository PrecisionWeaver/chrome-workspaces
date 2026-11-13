import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { errorMessage } from '../../../shared/protocol/errors';
import type { AdminAction, UpdateStatus } from '../../../shared/protocol/protocol';
import { pathBytes, type Proc, subtree } from '../platform/system';
import { applyUpdate, checkUpdates as readUpdates } from '../platform/updates';
import type { ActionResult, AdminOptions } from './admin';
import { launchctl } from './shell';

const execFileAsync = promisify(execFile);

/** What an action runs against: the service's options, read when the action runs, and the process table. */
export interface ActionContext {
  options: AdminOptions;
  readProcs: () => Promise<Proc[]>;
}

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** Runs one Settings action and says what it did. */
export async function runAction(context: ActionContext, request: AdminAction): Promise<ActionResult> {
  const { options } = context;
  const { sessions, paths } = options;
  switch (request.action) {
    case 'restartSession': {
      const session = sessions.get(request.id);
      if (!session) return { ok: true, message: 'No session was running; it starts when the workspace is opened.', reset: [request.id] };
      // Silenced first, so a panel attached to it is not told the shell exited (which closes the panel).
      session.silence();
      sessions.remove(request.id);
      return { ok: true, message: 'Session ended. It starts again, resuming the conversation, when the workspace is opened.', reset: [request.id] };
    }
    case 'killProcess':
      return killProcess(context, request.id, request.pid, request.force === true);
    case 'restartHelper':
      if (!(await options.isManaged()))
        return { ok: false, message: 'The helper was not started by launchd, so it cannot restart itself. Run npm run agent:start first.' };
      options.spawnDetached(launchctl('kickstart -k'));
      return { ok: true, message: 'Restarting. Every open terminal ends, and the panel reconnects in a few seconds.' };
    case 'stopHelper':
      if (!(await options.isManaged())) return { ok: false, message: 'The helper was not started by launchd. Stop it where you started it.' };
      options.spawnDetached(launchctl('bootout'));
      return { ok: true, message: 'Stopping. Run npm run agent:start to bring it back.' };
    case 'clearUploads': {
      const bytes = pathBytes(paths.uploadDir);
      let files = 0;
      if (existsSync(paths.uploadDir)) {
        for (const name of readdirSync(paths.uploadDir)) {
          files += readdirSync(join(paths.uploadDir, name)).length;
          rmSync(join(paths.uploadDir, name), { recursive: true, force: true });
        }
      }
      return { ok: true, message: `Removed ${files} file${files === 1 ? '' : 's'} (${megabytes(bytes)}).` };
    }
    case 'clearLog':
      try {
        truncateSync(paths.logFile, 0);
        return { ok: true, message: 'Log cleared.' };
      } catch (error) {
        return { ok: false, message: errorMessage(error) };
      }
    case 'pruneWorktrees':
      return pruneWorktrees(options.store.list());
    case 'applyUpdate': {
      if (!options.repoDir) return { ok: false, message: 'This copy of the app is not a git checkout, so it cannot update itself.' };
      const outcome = await applyUpdate(options.repoDir, (command) => options.runShell(`cd "${options.repoDir}" && ${command}`));
      // The new code only runs after a restart, which ends every terminal, so it is left to launchd and only when it manages us.
      if (outcome.ok && outcome.restart && !(await options.isManaged())) {
        return { ok: true, message: `${outcome.message.split(' The helper')[0]} Restart the helper by hand, then reload the extension.` };
      }
      if (outcome.ok && outcome.restart) options.spawnDetached(launchctl('kickstart -k'));
      return { ok: outcome.ok, message: outcome.message };
    }
    case 'checkGh': {
      const { output, ok } = await options.runShell('gh auth status 2>&1');
      return { ok, message: output.split('\n').slice(0, 4).join(' · ') || (ok ? 'gh is signed in.' : 'gh is not signed in.') };
    }
  }
}

/** Signals a process inside a workspace's shell tree, and everything beneath it. */
export async function killProcess({ options, readProcs }: ActionContext, id: string, pid: number, force: boolean): Promise<ActionResult> {
  const root = options.sessions.get(id)?.pid;
  if (root == null) return { ok: false, message: 'That workspace has no running session.' };
  const tree = subtree(await readProcs(), root);
  // Only processes inside the workspace's own shell tree can be signalled, never the shell itself or the helper.
  if (pid === root || pid === process.pid || !tree.some((p) => p.pid === pid)) {
    return { ok: false, message: 'That process is not running inside this workspace.' };
  }
  const doomed = subtree(tree, pid).reverse();
  for (const proc of doomed) {
    try {
      process.kill(proc.pid, force ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  return { ok: true, message: `${force ? 'Killed' : 'Asked to stop'} ${doomed.length} process${doomed.length === 1 ? '' : 'es'}.` };
}

/** Runs `git worktree prune` once per repository the workspaces are in. */
export async function pruneWorktrees(workspaces: readonly { cwd: string }[]): Promise<ActionResult> {
  const roots = new Map<string, string>();
  for (const ws of workspaces) {
    if (!existsSync(ws.cwd)) continue;
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ws.cwd, timeout: 10_000 });
      roots.set(stdout.trim(), ws.cwd);
    } catch {
      // Not a repository.
    }
  }
  let pruned = 0;
  for (const cwd of roots.values()) {
    try {
      const { stdout, stderr } = await execFileAsync('git', ['worktree', 'prune', '-v'], { cwd, timeout: 30_000 });
      pruned += `${stdout}${stderr}`.split('\n').filter((line) => line.startsWith('Removing')).length;
    } catch {
      // Leave a repository that will not prune.
    }
  }
  return {
    ok: true,
    message: `Checked ${roots.size} repositor${roots.size === 1 ? 'y' : 'ies'}; removed ${pruned} stale worktree record${pruned === 1 ? '' : 's'}.`,
  };
}

/** What an update would bring; throws when this copy is not a git checkout. */
export async function checkUpdates(repoDir: string | null): Promise<UpdateStatus> {
  if (!repoDir) throw new Error('This copy of the app is not a git checkout, so it cannot check for updates.');
  return readUpdates(repoDir);
}
