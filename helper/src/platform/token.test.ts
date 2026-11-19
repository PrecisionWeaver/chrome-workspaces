import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadOrCreateToken } from './token';

describe('loadOrCreateToken', () => {
  it('creates a 64-hex-character token readable only by the owner', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cw-token-')), 'data');
    const token = loadOrCreateToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
  });

  it('tightens a token file that others could read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-token-'));
    writeFileSync(join(dir, 'token'), 'abc\n', { mode: 0o644 });
    expect(loadOrCreateToken(dir)).toBe('abc');
    expect(statSync(join(dir, 'token')).mode & 0o777).toBe(0o600);
  });

  it('returns the same token on later calls', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-token-'));
    expect(loadOrCreateToken(dir)).toBe(loadOrCreateToken(dir));
  });
});
