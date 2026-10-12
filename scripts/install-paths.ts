import { homedir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_HOST_NAME } from '../shared/protocol';
import { AGENT_LABEL, DATA_DIR } from '../helper/src/config';

/** Everything `setup` writes outside the data directory, so `uninstall` and `doctor` agree with it. */
export const agentFile = join(homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
export const hostManifest = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`);
export const hostWrapper = join(DATA_DIR, 'native-host.sh');
