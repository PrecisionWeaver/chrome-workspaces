import { describe, expect, it } from 'vitest';
import { isAuthorized, tokenFromProtocols, tokenMatches } from './auth';

const ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const policy = { token: 'a'.repeat(64), allowedOrigins: [ORIGIN] };

describe('tokenFromProtocols', () => {
  it('extracts the token entry from the subprotocol header', () => {
    expect(tokenFromProtocols(`cw.v1, token.${'a'.repeat(64)}`)).toBe('a'.repeat(64));
  });

  it('returns null when no token entry is present', () => {
    expect(tokenFromProtocols('cw.v1')).toBeNull();
    expect(tokenFromProtocols(undefined)).toBeNull();
  });
});

describe('tokenMatches', () => {
  it('accepts the same token and rejects a different one, including one of another length', () => {
    expect(tokenMatches('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    expect(tokenMatches('b'.repeat(64), 'a'.repeat(64))).toBe(false);
    expect(tokenMatches('a', 'a'.repeat(64))).toBe(false);
    expect(tokenMatches('', 'a')).toBe(false);
  });
});

describe('isAuthorized', () => {
  it('accepts the extension origin with the right token', () => {
    expect(isAuthorized(policy, ORIGIN, 'a'.repeat(64))).toBe(true);
  });

  it('rejects any other origin', () => {
    expect(isAuthorized(policy, 'https://evil.example', 'a'.repeat(64))).toBe(false);
  });

  it('rejects a missing origin', () => {
    expect(isAuthorized(policy, undefined, 'a'.repeat(64))).toBe(false);
  });

  it('rejects a wrong or missing token', () => {
    expect(isAuthorized(policy, ORIGIN, 'b'.repeat(64))).toBe(false);
    expect(isAuthorized(policy, ORIGIN, 'a')).toBe(false);
    expect(isAuthorized(policy, ORIGIN, null)).toBe(false);
  });
});
