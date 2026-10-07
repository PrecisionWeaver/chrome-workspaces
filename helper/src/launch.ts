import type { Workspace } from '../../shared/protocol';
import type { SessionSpec } from './session';

// The id is interpolated into a shell command, so only a bare session uuid is accepted.
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LaunchOptions {
  shell: string;
  /** Claude session to resume; by id because workspaces can share a cwd, which defeats `--continue`. */
  resumeId: string | null;
}

/** Runs claude inside a login shell, leaving the shell behind when claude quits. */
export function launchSpec(workspace: Workspace, { shell, resumeId }: LaunchOptions): SessionSpec {
  const claude = resumeId && SESSION_UUID.test(resumeId) ? `claude --resume ${resumeId}` : 'claude';
  const env: Record<string, string> = { CW_WORKSPACE_ID: workspace.id };
  if (workspace.ticket) env.DEVSPACE_TICKET = workspace.ticket;

  return {
    id: workspace.id,
    command: shell,
    args: ['-l', '-i', '-c', `${claude}; exec ${shell} -l -i`],
    cwd: workspace.cwd,
    env,
  };
}
