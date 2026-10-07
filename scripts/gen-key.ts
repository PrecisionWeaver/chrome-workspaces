import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { extensionIdFromKey } from './extension-id';

const MANIFEST = 'extension/manifest.json';
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as Record<string, unknown>;

if (typeof manifest.key === 'string') {
  console.log(`key already set; extension id ${extensionIdFromKey(manifest.key)}`);
} else {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const key = publicKey.toString('base64');
  writeFileSync(MANIFEST, `${JSON.stringify({ ...manifest, key }, null, 2)}\n`);
  console.log(`wrote key; extension id ${extensionIdFromKey(key)}`);
}
