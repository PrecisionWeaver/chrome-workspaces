import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AGENT_LABEL, DATA_DIR, HOST, loadConfig, PORT, type HelperConfig } from '../helper/src/config';
import { extensionIdFromManifest } from './extension-id';
import { HOOK_SCRIPT, typeStrippingSupported } from '../helper/src/hooks-config';
import { agentFile, hostManifest, hostWrapper } from './install-paths';

// Checks an install from the command line, for when the panel cannot reach the helper to show its own checklist.
const execFileAsync = promisify(execFile);
const repo = resolve(import.meta.dirname, '..');
const shell = process.env.SHELL ?? '/bin/zsh';

type Result = { ok: true; detail: string } | { ok: false; detail: string; fix: string; optional?: boolean };
const pass = (detail: string): Result => ({ ok: true, detail });
const fail = (detail: string, fix: string, optional = false): Result => ({ ok: false, detail, fix, optional });

const succeeds = (command: string, args: string[]) =>
  execFileAsync(command, args, { timeout: 15_000 }).then(
    () => true,
    () => false,
  );

let config: HelperConfig | null = null;
const extensionId = extensionIdFromManifest(join(repo, 'extension', 'manifest.json'));
const version = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { version?: string }).version;

const checks: [string, () => Promise<Result> | Result][] = [
  [
    'Node 22.18 or newer',
    () =>
      typeStrippingSupported(process.versions.node)
        ? pass(process.versions.node)
        : fail(process.versions.node, 'Install Node 22.18 or newer; the status hooks need it.'),
  ],
  [
    'Config file',
    () => {
      try {
        config = loadConfig();
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error), 'Run npm run setup, or fix the JSON by hand.');
      }
      return config.problems.length ? fail(config.problems.join(' '), 'See docs/configuration.md.') : pass(join(DATA_DIR, 'config.json'));
    },
  ],
  [
    'Extension ID',
    () =>
      !config
        ? fail('No config to compare with.', 'Fix the config first.')
        : config.extensionId === extensionId
          ? pass(extensionId)
          : fail(`The config expects ${config.extensionId}, the manifest gives ${extensionId}.`, 'Run npm run setup.'),
  ],
  [
    'Extension built',
    () => {
      const built = join(repo, 'extension', 'dist', 'manifest.json');
      if (!existsSync(built)) return fail('extension/dist is missing.', 'Run npm run build:extension.');
      const want = version(join(repo, 'package.json'));
      return version(built) === want
        ? pass(`v${want}`)
        : fail(`dist is v${version(built)}, the source is v${want}.`, 'Run npm run build:extension, then reload the extension.');
    },
  ],
  [
    'Native messaging host',
    () =>
      existsSync(hostManifest) && existsSync(hostWrapper) && readFileSync(hostManifest, 'utf8').includes(extensionId)
        ? pass(hostManifest)
        : fail('Not installed, or for another extension ID.', 'Run npm run setup, then quit and reopen Chrome.'),
  ],
  ['LaunchAgent installed', () => (existsSync(agentFile) ? pass(agentFile) : fail('No plist.', 'Run npm run setup.'))],
  [
    'Helper loaded in launchd',
    async () =>
      (await succeeds('launchctl', ['print', `gui/${process.getuid?.() ?? 0}/${AGENT_LABEL}`]))
        ? pass(AGENT_LABEL)
        : fail('Not loaded.', 'Run npm run agent:start.'),
  ],
  [
    'Helper answering',
    async () => {
      try {
        const token = readFileSync(join(DATA_DIR, 'token'), 'utf8').trim();
        const response = await fetch(`http://${HOST}:${PORT}/workspaces`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
        return response.ok ? pass(`${HOST}:${PORT}`) : fail(`It replied ${response.status}.`, `Check ${join(DATA_DIR, 'helper.log')}.`);
      } catch (error) {
        return fail(
          `Nothing at ${HOST}:${PORT} (${error instanceof Error ? error.message : String(error)}).`,
          `Run npm run agent:restart, then check ${join(DATA_DIR, 'helper.log')}.`,
        );
      }
    },
  ],
  [
    'claude on the login shell PATH',
    async () => {
      const command = config?.claudeCommand ?? 'claude';
      for (const name of new Set([command, 'claude'])) {
        if (await succeeds(shell, ['-l', '-c', `command -v ${name}`])) return pass(name === command ? name : `${name} (${command} not found, so claude runs)`);
      }
      return fail('Not found.', 'Install Claude Code, and make sure your login shell puts it on PATH.');
    },
  ],
  [
    'GitHub CLI signed in',
    async () =>
      (await succeeds(shell, ['-l', '-c', 'gh auth status']))
        ? pass('gh auth status is fine.')
        : fail('gh is missing or signed out, so review requests are empty.', 'Install gh, then run gh auth login.', true),
  ],
  [
    'Status hooks',
    () => {
      if (!typeStrippingSupported(process.versions.node)) return fail(`Node ${process.versions.node} cannot run the hook script.`, 'Use Node 22.18 or newer.');
      if (!existsSync(HOOK_SCRIPT)) return fail(`${HOOK_SCRIPT} is missing.`, 'Restore it with git checkout.');
      return existsSync(join(DATA_DIR, 'hooks.json'))
        ? pass(join(DATA_DIR, 'hooks.json'))
        : fail('The helper has not written hooks.json.', 'Run npm run agent:restart.');
    },
  ],
];

let failed = 0;
for (const [label, check] of checks) {
  const result = await check();
  if (result.ok) console.log(`✓ ${label}: ${result.detail}`);
  else {
    if (!result.optional) failed++;
    console.log(`${result.optional ? '–' : '✗'} ${label}: ${result.detail}\n    ${result.fix}`);
  }
}
console.log(failed ? `\n${failed} problem${failed === 1 ? '' : 's'} to fix.` : '\nAll good.');
process.exitCode = failed ? 1 : 0;
