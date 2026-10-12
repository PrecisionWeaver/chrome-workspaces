import { MODEL_PATTERN, MONITOR_SESSION, SHELL_SESSION, type Workspace } from '../../shared/protocol';
import type { SessionSpec } from './session';

// The id is interpolated into a shell command, so only a bare session uuid is accepted.
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LaunchOptions {
  shell: string;
  /** Claude session to resume; by id because workspaces can share a cwd, which defeats `--continue`. */
  resumeId: string | null;
  /** Used by workspaces that did not pick a model. */
  defaultModel?: string | null;
  /** `claudeCommand` from the config, already checked to be a bare command name. */
  command?: string;
  /** A claude settings file that adds the status hooks, from `writeHooksFile`; null leaves claude without them. */
  hooksFile?: string | null;
}

/**
 * The system monitor: btop when the login shell can find it, else top. The session ends when the program quits,
 * and `server.ts` ends it when the panel stops looking, so nothing keeps sampling the machine unseen.
 */
export function monitorSpec(shell: string, cwd: string): SessionSpec {
  return { id: MONITOR_SESSION, command: shell, args: ['-l', '-i', '-c', 'if command -v btop >/dev/null 2>&1; then exec btop; else exec top; fi'], cwd };
}

/**
 * A plain login shell. It has no workspace id, so a `claude` typed into it is not tracked, and it stays running
 * when the panel stops looking, so a dev server started in it keeps going; exiting the shell ends the session.
 */
export function shellSpec(shell: string, cwd: string): SessionSpec {
  return { id: SHELL_SESSION, command: shell, args: ['-l', '-i'], cwd };
}

/**
 * Runs claude inside a login shell, leaving the shell behind when claude quits. A configured wrapper
 * command must pass claude's arguments through; claude itself is the fallback when the shell cannot find it.
 */
export function launchSpec(workspace: Workspace, { shell, resumeId, defaultModel = null, command = 'claude', hooksFile = null }: LaunchOptions): SessionSpec {
  const env: Record<string, string> = { CW_WORKSPACE_ID: workspace.id };
  if (workspace.ticket) env.DEVSPACE_TICKET = workspace.ticket;

  // The pattern keeps quotes and spaces out, so the value is safe inside single quotes.
  const model = workspace.model ?? defaultModel;
  let args = model && MODEL_PATTERN.test(model) ? ` --model '${model}'` : '';
  let cleanup = '';
  if (resumeId && SESSION_UUID.test(resumeId)) args += ` --resume ${resumeId}`;
  else if (workspace.prompt) {
    // The shell expands the prompt from the environment, so its text is never parsed as shell syntax.
    env.CW_PROMPT = workspace.prompt;
    args += ' "$CW_PROMPT"';
    cleanup = 'unset CW_PROMPT; ';
  }
  // Through the environment, like the prompt, so the path is never parsed as shell syntax.
  if (hooksFile) {
    env.CW_HOOKS = hooksFile;
    args += ' --settings "$CW_HOOKS"';
  }
  const claude = command === 'claude' ? `claude${args}` : `if command -v ${command} >/dev/null 2>&1; then ${command}${args}; else claude${args}; fi`;

  return {
    id: workspace.id,
    command: shell,
    args: ['-l', '-i', '-c', `${claude}; ${cleanup}exec ${shell} -l -i`],
    cwd: workspace.cwd,
    env,
  };
}
