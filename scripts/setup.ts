import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { AGENT_LABEL, DATA_DIR } from '../helper/src/platform/config';
import { extensionIdFromManifest } from './extension-id';
import { agentFile, hostManifest, hostWrapper as wrapper } from './install-paths';
import { agentPlist, hostManifestJson, hostWrapperScript, mergedConfig } from './setup-files';

const repo = resolve(import.meta.dirname, '..');
const extensionId = extensionIdFromManifest(join(repo, 'extension', 'manifest.json'));

// `npm run setup -- --default-cwd <dir>` sets where new workspaces start; otherwise an existing value is kept.
const flag = process.argv.indexOf('--default-cwd');
const requestedCwd = flag === -1 ? undefined : resolve(process.argv[flag + 1] ?? '');
if (requestedCwd !== undefined && !(existsSync(requestedCwd) && statSync(requestedCwd).isDirectory())) {
  throw new Error(`--default-cwd is not a directory: ${requestedCwd}`);
}

// `--repo-root <dir>`, repeatable, sets the folders the Repo picker lists; otherwise an existing value is kept.
const repoRoots = process.argv.flatMap((arg, i) => (arg === '--repo-root' ? [resolve(process.argv[i + 1] ?? '')] : []));
const missingRoot = repoRoots.find((root) => !(existsSync(root) && statSync(root).isDirectory()));
if (missingRoot) throw new Error(`--repo-root is not a directory: ${missingRoot}`);

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
const configFile = join(DATA_DIR, 'config.json');
const existing = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, 'utf8')) as Record<string, unknown> & { defaultCwd?: string }) : {};
const defaultCwd = requestedCwd ?? existing.defaultCwd ?? homedir();
writeFileSync(configFile, mergedConfig(existing, { extensionId, defaultCwd, repoRoots }));

// A starter prompts note, only if there is none, so From prompt has something to pick on a fresh install.
const promptsFile = join(DATA_DIR, 'prompts.md');
if (!existsSync(promptsFile) && !('promptsFile' in existing)) copyFileSync(join(repo, 'prompts.example.md'), promptsFile);

writeFileSync(wrapper, hostWrapperScript(repo, process.execPath));
chmodSync(wrapper, 0o755);

mkdirSync(dirname(hostManifest), { recursive: true });
writeFileSync(hostManifest, hostManifestJson(wrapper, extensionId));

mkdirSync(dirname(agentFile), { recursive: true });
writeFileSync(
  agentFile,
  agentPlist({
    label: AGENT_LABEL,
    node: process.execPath,
    repo,
    shell: process.env.SHELL ?? '/bin/zsh',
    lang: process.env.LANG ?? 'en_US.UTF-8',
    logFile: join(DATA_DIR, 'helper.log'),
  }),
);

console.log(`extension id: ${extensionId}`);
console.log(`default workspace directory: ${defaultCwd}`);
if (repoRoots.length) console.log(`repo folders: ${repoRoots.join(', ')}`);
console.log(`wrote ${agentFile} (start it with npm run agent:start)`);
console.log(`wrote ${configFile}`);
console.log(`wrote ${wrapper}`);
console.log(`wrote ${hostManifest}`);
