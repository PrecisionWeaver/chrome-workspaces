import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function extensionIdFromKey(base64Key: string): string {
  const hex = createHash('sha256').update(Buffer.from(base64Key, 'base64')).digest('hex').slice(0, 32);
  return [...hex].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

export function extensionIdFromManifest(manifestPath: string): string {
  const { key } = JSON.parse(readFileSync(manifestPath, 'utf8')) as { key?: string };
  if (!key) throw new Error(`${manifestPath} has no "key"; run npm run gen-key first`);
  return extensionIdFromKey(key);
}
