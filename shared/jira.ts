const TICKET_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/** A Jira site's address as configured, kept only if it is a plain https origin; anything else is null. */
export function normalizeJiraBase(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** The address of a ticket on the configured site, or null with no site or a key that is not a ticket key. */
export function ticketUrl(base: string | null, ticket: string | null): string | null {
  if (!base || !ticket || !TICKET_KEY.test(ticket)) return null;
  return `${base}/browse/${ticket}`;
}
