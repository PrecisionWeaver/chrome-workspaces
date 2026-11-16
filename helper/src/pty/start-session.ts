import { MONITOR_SESSION, SHELL_SESSION, WORKSPACE_SHELL_PREFIX, type Workspace } from '../../../shared/protocol/protocol';
import { isDirectory } from '../platform/config';
import { launchDirectory } from './launch-dir';
import { launchSpec, monitorSpec, shellSpec } from './launch';
import type { Session, SessionSpec } from './session';

export interface StartSessionDeps {
  shell: string;
  /** The directory a bare terminal, and a workspace shell whose directory is gone, start in. */
  defaultCwd: string;
  /** The directory the system monitor starts in. */
  home: string;
  defaultModel?: string | null;
  claudeCommand?: string;
  claudeArgs?: string[];
  hooksFile: string | null;
  store: { get(id: string): Workspace | undefined; clearPrompt(id: string): void };
  sessions: { create(spec: SessionSpec): Session };
  /** An earlier conversation picked for a workspace; used by its next start alone. */
  resumeOverride: Map<string, string>;
  /** The claude session the hooks last reported for a workspace. */
  claudeSessionId(id: string): string | null;
  /** Where a workspace's claude last was: the worktree it moved into, else where it started. */
  workingDir(id: string): string | null;
  log?(line: string): void;
  /** Where a resumed session starts; replaceable, since it asks git. */
  launchDirectory?: typeof launchDirectory;
}

/**
 * Starts the session the panel asked to attach to and the helper does not have: the system monitor, the plain
 * terminal, a workspace's own shell, or a workspace's claude. Undefined for an id that is none of them.
 */
export function startSession(id: string, deps: StartSessionDeps): Session | undefined {
  const { shell, store, sessions, defaultCwd } = deps;
  if (id === MONITOR_SESSION) return sessions.create(monitorSpec(shell, deps.home));
  if (id === SHELL_SESSION) return sessions.create(shellSpec(shell, defaultCwd));
  // A workspace's own shell starts in its directory, a worktree included, and has no workspace id, so a claude typed into it is not tracked.
  if (id.startsWith(WORKSPACE_SHELL_PREFIX)) {
    const owner = store.get(id.slice(WORKSPACE_SHELL_PREFIX.length));
    return owner ? sessions.create(shellSpec(shell, isDirectory(owner.cwd) ? owner.cwd : defaultCwd, id)) : undefined;
  }
  const workspace = store.get(id);
  if (!workspace) return undefined;
  // A restored workspace has no session of its own yet, so it resumes the one it had.
  const resumeId = deps.resumeOverride.get(id) ?? deps.claudeSessionId(id) ?? workspace.resume ?? null;
  deps.resumeOverride.delete(id);
  // Resuming starts where claude was, which may be a worktree it moved into; a new conversation starts in the workspace's directory.
  const cwd = resumeId ? (deps.launchDirectory ?? launchDirectory)(workspace.cwd, deps.workingDir(id)) : undefined;
  const spec = launchSpec(workspace, {
    shell,
    resumeId,
    cwd,
    defaultModel: deps.defaultModel,
    command: deps.claudeCommand,
    args: deps.claudeArgs,
    hooksFile: deps.hooksFile,
  });
  const session = sessions.create(spec);
  deps.log?.(`started ${workspace.name} in ${spec.cwd}${spec.args.join(' ').includes('--resume') ? ', resuming its conversation' : ''}`);
  // The prompt went into the launch, so the workspace's next start does not send it again.
  if (spec.env?.CW_PROMPT !== undefined) store.clearPrompt(id);
  return session;
}
