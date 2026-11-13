import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { errorMessage } from '../../../shared/protocol/errors';
import { AGENT_LABEL } from '../platform/config';

const execFileAsync = promisify(execFile);

/** Runs a command line in a login shell, resolving with its output and whether it exited cleanly. */
export function defaultRunShell(shell: string) {
  return async (command: string): Promise<{ output: string; ok: boolean }> => {
    try {
      const { stdout, stderr } = await execFileAsync(shell, ['-l', '-c', command], { timeout: 15_000, maxBuffer: 1024 * 1024 });
      return { output: `${stdout}${stderr}`.trim(), ok: true };
    } catch (error) {
      const { stdout, stderr } = error as { stdout?: string; stderr?: string };
      return { output: `${stdout ?? ''}${stderr ?? ''}`.trim() || errorMessage(error), ok: false };
    }
  };
}

/** Starts a command that outlives the helper. */
export function defaultSpawnDetached(command: string): void {
  spawn('sh', ['-c', command], { detached: true, stdio: 'ignore' }).unref();
}

/** Whether launchd runs this process. */
export async function defaultIsManaged(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${AGENT_LABEL}`], { timeout: 5000 });
    return stdout.includes(`pid = ${process.pid}`);
  } catch {
    return false;
  }
}

/** The command that restarts or stops the helper's agent, after a pause so the reply reaches the panel first. */
export const launchctl = (verb: 'kickstart -k' | 'bootout') => `sleep 1; launchctl ${verb} gui/${process.getuid?.() ?? 0}/${AGENT_LABEL}`;
