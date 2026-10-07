import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { NATIVE_HOST_NAME } from '../shared/protocol';
import { DATA_DIR } from '../helper/src/config';
import { extensionIdFromManifest } from './extension-id';

const repo = resolve(import.meta.dirname, '..');
const extensionId = extensionIdFromManifest(join(repo, 'extension', 'manifest.json'));

mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
writeFileSync(join(DATA_DIR, 'config.json'), `${JSON.stringify({ extensionId }, null, 2)}\n`);

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

console.log(`extension id: ${extensionId}`);
console.log(`wrote ${join(DATA_DIR, 'config.json')}`);
console.log(`wrote ${wrapper}`);
console.log(`wrote ${hostManifest}`);
