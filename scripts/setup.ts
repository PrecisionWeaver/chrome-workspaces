import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { NATIVE_HOST_NAME } from '../shared/protocol';
import { DATA_DIR } from '../helper/src/config';
import { extensionIdFromManifest } from './extension-id';

const AGENT_LABEL = 'com.chrome-workspaces.helper';

const repo = resolve(import.meta.dirname, '..');
const extensionId = extensionIdFromManifest(join(repo, 'extension', 'manifest.json'));

// `npm run setup -- --default-cwd <dir>` sets where new workspaces start; otherwise an existing value is kept.
const flag = process.argv.indexOf('--default-cwd');
const requestedCwd = flag === -1 ? undefined : resolve(process.argv[flag + 1] ?? '');
if (requestedCwd !== undefined && !(existsSync(requestedCwd) && statSync(requestedCwd).isDirectory())) {
  throw new Error(`--default-cwd is not a directory: ${requestedCwd}`);
}

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const configFile = join(DATA_DIR, 'config.json');
const existing = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown> & { defaultCwd?: string }) : {};
const defaultCwd = requestedCwd ?? existing.defaultCwd ?? homedir();
writeFileSync(configFile, `${JSON.stringify({ ...existing, extensionId, defaultCwd }, null, 2)}\n`);

// Chrome launches the host with an unknown cwd and a minimal PATH, so pin both.
const wrapper = join(DATA_DIR, 'native-host.sh');
writeFileSync(wrapper, `#!/bin/sh\ncd "${repo}" && exec "${process.execPath}" --import tsx helper/src/native-host.ts\n`);
chmodSync(wrapper, 0o755);

const hostsDir = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
mkdirSync(hostsDir, { recursive: true });
const hostManifest = join(hostsDir, `${NATIVE_HOST_NAME}.json`);
writeFileSync(
  hostManifest,
  `${JSON.stringify(
    {
      name: NATIVE_HOST_NAME,
      description: 'Chrome Workspaces token bridge',
      path: wrapper,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionId}/`],
    },
    null,
    2,
  )}\n`,
);

// launchd starts agents with almost no environment; shells need SHELL, and claude needs a UTF-8 locale.
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const agentFile = join(homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
const programArguments = [process.execPath, '--import', 'tsx', 'helper/src/main.ts'];
mkdirSync(dirname(agentFile), { recursive: true });
writeFileSync(
  agentFile,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SHELL</key><string>${xml(process.env.SHELL ?? '/bin/zsh')}</string>
    <key>LANG</key><string>${xml(process.env.LANG ?? 'en_US.UTF-8')}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(join(DATA_DIR, 'helper.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(DATA_DIR, 'helper.log'))}</string>
</dict>
</plist>
`,
);

console.log(`extension id: ${extensionId}`);
console.log(`default workspace directory: ${defaultCwd}`);
console.log(`wrote ${agentFile} (start it with npm run agent:start)`);
console.log(`wrote ${configFile}`);
console.log(`wrote ${wrapper}`);
console.log(`wrote ${hostManifest}`);
