import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { AGENT_LABEL, DATA_DIR } from '../helper/src/config';
import { agentFile, hostManifest, hostWrapper } from './install-paths';

// Undoes `npm run setup`. The data directory (workspaces, config, prompts, history) stays unless --purge is given.
const purge = process.argv.includes('--purge');

try {
  execFileSync('launchctl', ['bootout', `gui/${process.getuid?.() ?? 0}/${AGENT_LABEL}`], { stdio: 'ignore' });
  console.log('stopped the helper (every workspace terminal has ended)');
} catch {
  console.log('the helper was not running under launchd');
}

for (const file of [agentFile, hostManifest, hostWrapper]) {
  if (!existsSync(file)) continue;
  rmSync(file);
  console.log(`removed ${file}`);
}

if (purge && existsSync(DATA_DIR)) {
  rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`removed ${DATA_DIR}`);
} else if (existsSync(DATA_DIR)) {
  console.log(`kept ${DATA_DIR} (workspaces, config, prompts); rerun with --purge to delete it`);
}

console.log('\nLeft for you: remove the extension at chrome://extensions, then delete this folder.');
