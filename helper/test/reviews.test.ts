import { describe, expect, it } from 'vitest';
import { parseReviewRequests, ReviewsPoller, ticketFromTitle } from '../src/reviews';

const pr = (number: number, title: string, updatedAt: string) => ({
  author: { login: 'drew', is_bot: false },
  isDraft: number === 2,
  number,
  repository: { name: 'pec-platform', nameWithOwner: 'vorys-econtrol/pec-platform' },
  title,
  updatedAt,
  url: `https://github.com/vorys-econtrol/pec-platform/pull/${number}`,
});
const GH = JSON.stringify([pr(1, 'ORC-10 - Fix it', '2026-10-01T00:00:00Z'), pr(2, 'Tidy up', '2026-10-02T00:00:00Z')]);

describe('ticketFromTitle', () => {
  it('prefers a key outside brackets, since a bracketed key names the parent', () => {
    expect(ticketFromTitle('[ORC-1731] ORC-1737 - Sync cache')).toBe('ORC-1737');
    expect(ticketFromTitle('[ORC-1731] Sync cache')).toBe('ORC-1731');
    expect(ticketFromTitle('OPS-88: fix')).toBe('OPS-88');
    expect(ticketFromTitle('Bump deps')).toBeNull();
  });
});

describe('parseReviewRequests', () => {
  it('maps gh search output, most recently updated first', () => {
    expect(parseReviewRequests(GH)).toEqual([
      { repo: 'vorys-econtrol/pec-platform', number: 2, title: 'Tidy up', url: 'https://github.com/vorys-econtrol/pec-platform/pull/2', author: 'drew', isDraft: true, updatedAt: '2026-10-02T00:00:00Z', ticket: null },
      { repo: 'vorys-econtrol/pec-platform', number: 1, title: 'ORC-10 - Fix it', url: 'https://github.com/vorys-econtrol/pec-platform/pull/1', author: 'drew', isDraft: false, updatedAt: '2026-10-01T00:00:00Z', ticket: 'ORC-10' },
    ]);
  });

  it('rejects output that is not a list', () => {
    expect(() => parseReviewRequests('{"message":"Bad credentials"}')).toThrow();
  });
});

describe('ReviewsPoller', () => {
  it('starts empty, then holds the fetched list and notifies', async () => {
    const poller = new ReviewsPoller(async () => GH);
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
      return GH;
    });
    await poller.refresh();
    fail = true;
    await poller.refresh();
    expect(poller.state().items).toHaveLength(2);
    expect(poller.state().error).toBe('gh: authentication required');
  });

  it('reports unparseable output as an error', async () => {
    const poller = new ReviewsPoller(async () => 'not json');
    await poller.refresh();
    expect(poller.state().error).toMatch(/JSON/);
  });

  it('shares a fetch already in flight', async () => {
    let calls = 0;
    const poller = new ReviewsPoller(async () => {
      calls++;
      return GH;
    });
    await Promise.all([poller.refresh(), poller.refresh()]);
    expect(calls).toBe(1);
  });
});
