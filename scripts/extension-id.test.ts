import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extensionIdFromKey } from './extension-id';

const publicKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'der' },
}).publicKey.toString('base64');

describe('extensionIdFromKey', () => {
  it('produces 32 characters in Chrome’s a–p alphabet', () => {
    expect(extensionIdFromKey(publicKey)).toMatch(/^[a-p]{32}$/);
  });

  it('is deterministic for the same key', () => {
    expect(extensionIdFromKey(publicKey)).toBe(extensionIdFromKey(publicKey));
  });
});
