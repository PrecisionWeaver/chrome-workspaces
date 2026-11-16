import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface GhOptions {
  /** Added to the environment, for values that must not travel in the command text. */
  env?: Record<string, string>;
  cwd?: string;
  /** Default 30 seconds. */
  timeoutMs?: number;
  /** Default 4 MB. */
  maxBufferBytes?: number;
  /** gh exits non-zero when GraphQL reports an error for some of what was asked, but its stdout still holds the rest. */
  keepStdout?: boolean;
  /** Fail with gh's own words (its stderr, or its last line) instead of the raw exec error. */
  stderrAs?: 'message' | 'last-line';
}

export type Exec = (
  file: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string; timeout: number; maxBuffer: number },
) => Promise<{ stdout: string }>;

/**
 * Runs a `gh` command and returns its stdout. launchd's PATH lacks Homebrew, so the command goes through a login
 * shell, which is also where gh's sign-in is found.
 */
export function createGh(shell: string, exec: Exec = execFileAsync as Exec) {
  return async (command: string, options: GhOptions = {}): Promise<string> => {
    try {
      const { stdout } = await exec(shell, ['-l', '-c', command], {
        ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
        ...(options.cwd ? { cwd: options.cwd } : {}),
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: options.maxBufferBytes ?? 4 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message: string };
      if (options.keepStdout && failure.stdout) return failure.stdout;
      if (!options.stderrAs) throw error;
      const stderr = failure.stderr?.trim();
      throw new Error((options.stderrAs === 'last-line' ? stderr?.split('\n').pop() : stderr) || failure.message);
    }
  };
}

/** gh prints the new pull request's url last; anything before it is its own chatter. */
export function newPullRequestUrl(stdout: string): string {
  const url = stdout.trim().split('\n').pop() ?? '';
  if (!/^https:\/\/github\.com\/.+\/pull\/\d+$/.test(url)) throw new Error(`gh did not say where the pull request is: ${url || 'no output'}`);
  return url;
}
