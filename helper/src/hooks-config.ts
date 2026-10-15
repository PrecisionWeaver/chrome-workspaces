import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STATUS_BY_EVENT } from '../../shared/session-file';

/** The script claude runs on session events. */
export const HOOK_SCRIPT = resolve(import.meta.dirname, '..', '..', 'hooks', 'session-state.ts');

/** The script claude runs as the status line, which keeps the plan's rate limits and then runs the person's own status line. */
export const STATUS_LINE_SCRIPT = resolve(import.meta.dirname, '..', '..', 'hooks', 'status-line.ts');

/** The script is TypeScript run directly by node, which can strip types from 22.18. */
export function typeStrippingSupported(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 18);
}

// The paths go into a shell command, and Node's can contain a space.
const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * A claude settings file that runs the hook on every event it tracks, and the status line wrapper when there is one.
 * The wrapper stands in for the status line in ~/.claude/settings.json, so it runs that one itself.
 */
export function hooksSettings(node: string, script: string, statusLineScript: string | null = null) {
  const command = `${quote(node)} ${quote(script)}`;
  return {
    hooks: Object.fromEntries(Object.keys(STATUS_BY_EVENT).map((event) => [event, [{ hooks: [{ type: 'command', command }] }]])),
    ...(statusLineScript ? { statusLine: { type: 'command', command: `${quote(node)} ${quote(statusLineScript)}` } } : {}),
  };
}

/**
 * Writes the file passed to every workspace's claude with `--settings`, so its hooks apply to those sessions
 * alone and nothing is written to ~/.claude. It is rewritten on every start, so a moved checkout or a new Node
 * corrects itself. Null when the hooks cannot run, in which case claude starts without them.
 */
export function writeHooksFile(
  dataDir: string,
  node = process.execPath,
  script = HOOK_SCRIPT,
  nodeVersion = process.versions.node,
  statusLineScript = STATUS_LINE_SCRIPT,
): string | null {
  if (!existsSync(script) || !typeStrippingSupported(nodeVersion)) return null;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = join(dataDir, 'hooks.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(hooksSettings(node, script, existsSync(statusLineScript) ? statusLineScript : null), null, 2)}\n`);
  renameSync(tmp, file);
  return file;
}
