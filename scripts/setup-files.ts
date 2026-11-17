import { NATIVE_HOST_NAME } from '../shared/protocol/protocol';

/** The contents of the files `setup` writes, kept apart from the writing so they can be tested. */

/** The config `setup` leaves: whatever was there, with the extension id and start directory set, and the repo folders when some were given. */
export function mergedConfig(existing: Record<string, unknown>, set: { extensionId: string; defaultCwd: string; repoRoots: readonly string[] }): string {
  const { extensionId, defaultCwd, repoRoots } = set;
  return `${JSON.stringify({ ...existing, extensionId, defaultCwd, ...(repoRoots.length ? { repoRoots } : {}) }, null, 2)}\n`;
}

/** The script Chrome runs as the native-messaging host. Chrome launches it with an unknown cwd and a minimal PATH, so both are pinned. */
export function hostWrapperScript(repo: string, node: string): string {
  return `#!/bin/sh\ncd "${repo}" && exec "${node}" --import tsx helper/src/native-host.ts\n`;
}

/** The manifest that lets this extension, and no other, start the native-messaging host. */
export function hostManifestJson(wrapper: string, extensionId: string): string {
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: 'Chrome Workspaces token bridge',
    path: wrapper,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface AgentPlist {
  label: string;
  node: string;
  repo: string;
  shell: string;
  lang: string;
  logFile: string;
}

/** The LaunchAgent that keeps the helper running. launchd starts agents with almost no environment; shells need SHELL, and claude needs a UTF-8 locale. */
export function agentPlist({ label, node, repo, shell, lang, logFile }: AgentPlist): string {
  const programArguments = [node, '--import', 'tsx', 'helper/src/main.ts'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments.map((arg) => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(repo)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>SHELL</key><string>${xml(shell)}</string>
    <key>LANG</key><string>${xml(lang)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}
