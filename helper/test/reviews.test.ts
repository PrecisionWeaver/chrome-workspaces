import { describe, expect, it } from 'vitest';
import { parseReviewRequests, ReviewsPoller, ticketFromTitle } from '../src/reviews';

const pr = (number: number, title: string, updatedAt: string) => ({
  author: { login: 'drew', is_bot: false },
  isDraft: number === 2,
  number,
  repository: { name: 'app', nameWithOwner: 'acme/app' },
  title,
  updatedAt,
  url: `https://github.com/acme/app/pull/${number}`,
});
const GH = JSON.stringify([pr(1, 'PROJ-10 - Fix it', '2026-10-01T00:00:00Z'), pr(2, 'Tidy up', '2026-10-02T00:00:00Z')]);

describe('ticketFromTitle', () => {
  it('prefers a key outside brackets, since a bracketed key names the parent', () => {
    expect(ticketFromTitle('[PROJ-1731] PROJ-1737 - Sync cache')).toBe('PROJ-1737');
    expect(ticketFromTitle('[PROJ-1731] Sync cache')).toBe('PROJ-1731');
    expect(ticketFromTitle('OPS-88: fix')).toBe('OPS-88');
    expect(ticketFromTitle('Bump deps')).toBeNull();
  });
});

describe('parseReviewRequests', () => {
  it('maps gh search output, most recently updated first', () => {
    expect(parseReviewRequests([GH])).toEqual([
      { repo: 'acme/app', number: 2, title: 'Tidy up', url: 'https://github.com/acme/app/pull/2', author: 'drew', isDraft: true, updatedAt: '2026-10-02T00:00:00Z', ticket: null },
      { repo: 'acme/app', number: 1, title: 'PROJ-10 - Fix it', url: 'https://github.com/acme/app/pull/1', author: 'drew', isDraft: false, updatedAt: '2026-10-01T00:00:00Z', ticket: 'PROJ-10' },
    ]);
  });

  it('merges several searches, listing a PR found by both once', () => {
    const other = JSON.stringify([pr(3, 'Starbase change', '2026-10-03T00:00:00Z'), pr(1, 'PROJ-10 - Fix it', '2026-10-01T00:00:00Z')]);
    expect(parseReviewRequests([GH, other]).map((r) => r.number)).toEqual([3, 2, 1]);
  });

  it('rejects output that is not a list', () => {
    expect(() => parseReviewRequests(['{"message":"Bad credentials"}'])).toThrow();
  });
});

describe('ReviewsPoller', () => {
  it('starts empty, then holds the fetched list and notifies', async () => {
    const poller = new ReviewsPoller(async () => [GH]);
    let changes = 0;
    poller.onChange(() => changes++);
    expect(poller.state()).toEqual({ items: [], error: null, fetchedAt: null });
    await poller.refresh();
    expect(poller.state().items.map((r) => r.number)).toEqual([2, 1]);
    expect(poller.state().error).toBeNull();
    expect(poller.state().fetchedAt).not.toBeNull();
    expect(changes).toBe(1);
  });

  it('keeps the last good list and reports the error when a fetch fails', async () => {
    let fail = false;
    const poller = new ReviewsPoller(async () => {
      if (fail) throw new Error('gh: authentication required');
      return [GH];
    });
    await poller.refresh();
    fail = true;
    await poller.refresh();
    expect(poller.state().items).toHaveLength(2);
    expect(poller.state().error).toBe('gh: authentication required');
  });

  it('reports unparseable output as an error', async () => {
    const poller = new ReviewsPoller(async () => ['not json']);
    await poller.refresh();
    expect(poller.state().error).toMatch(/JSON/);
  });

  it('shares a fetch already in flight', async () => {
    let calls = 0;
    const poller = new ReviewsPoller(async () => {
      calls++;
      return [GH];
    });
    await Promise.all([poller.refresh(), poller.refresh()]);
    expect(calls).toBe(1);
  });
});
