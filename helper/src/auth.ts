import { timingSafeEqual } from 'node:crypto';
import { TOKEN_PROTOCOL_PREFIX } from '../../shared/protocol';

export interface AuthPolicy {
  token: string;
  allowedOrigins: readonly string[];
}

export function tokenFromProtocols(header: string | undefined): string | null {
  if (!header) return null;
  for (const entry of header.split(',')) {
    const value = entry.trim();
    if (value.startsWith(TOKEN_PROTOCOL_PREFIX)) return value.slice(TOKEN_PROTOCOL_PREFIX.length);
  }
  return null;
}

export function isAuthorized(policy: AuthPolicy, origin: string | undefined, token: string | null): boolean {
  if (!origin || !policy.allowedOrigins.includes(origin)) return false;
  if (!token) return false;
  const given = Buffer.from(token);
  const expected = Buffer.from(policy.token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
