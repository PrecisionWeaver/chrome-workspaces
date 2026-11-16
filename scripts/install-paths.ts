import { homedir } from 'node:os';
import { join } from 'node:path';
import { NATIVE_HOST_NAME } from '../shared/protocol/protocol';
import { AGENT_PLIST, DATA_DIR } from '../helper/src/platform/config';

/** Everything `setup` writes outside the data directory, so `uninstall` and `doctor` agree with it. */
export const agentFile = AGENT_PLIST;
export const hostManifest = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts', `${NATIVE_HOST_NAME}.json`);
export const hostWrapper = join(DATA_DIR, 'native-host.sh');
