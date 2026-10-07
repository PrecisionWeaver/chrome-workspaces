import type { Workspace } from '../../shared/protocol';
import type { SessionSpec } from './session';

// The id is interpolated into a shell command, so only a bare session uuid is accepted.
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LaunchOptions {
  shell: string;
  /** Claude session to resume; by id because workspaces can share a cwd, which defeats `--continue`. */
  resumeId: string | null;
}

/**
 * Runs claude inside a login shell, leaving the shell behind when claude quits. Prefers the
 * `hr` compression-proxy launcher when the login shell can find it; `hr` passes claude args through.
 */
export function launchSpec(workspace: Workspace, { shell, resumeId }: LaunchOptions): SessionSpec {
  const env: Record<string, string> = { CW_WORKSPACE_ID: workspace.id };
  if (workspace.ticket) env.DEVSPACE_TICKET = workspace.ticket;

  let args = '';
  let cleanup = '';
  if (resumeId && SESSION_UUID.test(resumeId)) args = ` --resume ${resumeId}`;
  else if (workspace.prompt) {
    // The shell expands the prompt from the environment, so its text is never parsed as shell syntax.
    env.CW_PROMPT = workspace.prompt;
    args = ' "$CW_PROMPT"';
    cleanup = 'unset CW_PROMPT; ';
  }
  const claude = `if command -v hr >/dev/null 2>&1; then hr${args}; else claude${args}; fi`;

  return {
    id: workspace.id,
    command: shell,
    args: ['-l', '-i', '-c', `${claude}; ${cleanup}exec ${shell} -l -i`],
    cwd: workspace.cwd,
    env,
  };
}
