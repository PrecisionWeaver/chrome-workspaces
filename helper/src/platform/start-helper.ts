import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { AGENT_LABEL, AGENT_PLIST } from './config';

const execFileAsync = promisify(execFile);

export type Launchctl = (args: string[]) => Promise<void>;

const defaultLaunchctl: Launchctl = async (args) => {
  await execFileAsync('launchctl', args, { timeout: 10_000 });
};

/**
 * Brings the launchd-managed helper up. A stopped helper is unloaded, so it is bootstrapped from its
 * plist; one that is loaded but not running (it crashed, or KeepAlive is backing off) is kickstarted.
 */
export async function startHelper(launchctl: Launchctl = defaultLaunchctl, plist = AGENT_PLIST, uid = process.getuid?.() ?? 0): Promise<void> {
  const domain = `gui/${uid}`;
  const loaded = await launchctl(['print', `${domain}/${AGENT_LABEL}`]).then(
    () => true,
    () => false,
  );
  if (loaded) return launchctl(['kickstart', `${domain}/${AGENT_LABEL}`]);
  if (!existsSync(plist)) throw new Error('The launchd agent is not installed. Run npm run setup.');
  await launchctl(['bootstrap', domain, plist]);
}
