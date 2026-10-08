import { describe, expect, it } from 'vitest';
import { parseTabUrls, showsPage } from '../../shared/tab-urls';

describe('parseTabUrls', () => {
  it('reads one address per line or space, adding https:// to a bare domain', () => {
    expect(parseTabUrls('jira.example.com/browse/PROJ-1\n  http://localhost:3000/a?b=1  https://x.example\n\n')).toEqual({
      urls: ['https://jira.example.com/browse/PROJ-1', 'http://localhost:3000/a?b=1', 'https://x.example/'],
      invalid: [],
    });
  });

  it('reports entries that are not web addresses instead of opening them', () => {
    expect(parseTabUrls('https://ok.example javascript:alert(1) file:///etc/passwd chrome://settings')).toEqual({
      urls: ['https://ok.example/'],
      invalid: ['javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings'],
    });
  });

  it('returns nothing for blank text', () => {
    expect(parseTabUrls('  \n ')).toEqual({ urls: [], invalid: [] });
  });
});

describe('showsPage', () => {
  const pr = 'https://github.com/acme/web-app/pull/12';

  it('matches the same page despite a trailing slash, query or fragment', () => {
    expect(showsPage(`${pr}/`, pr)).toBe(true);
    expect(showsPage(`${pr}?diff=split#discussion_r1`, pr)).toBe(true);
  });

  it('counts a page beneath it, such as a PR\'s files tab, but not a sibling or a longer number', () => {
    expect(showsPage(`${pr}/files`, pr)).toBe(true);
    expect(showsPage('https://github.com/acme/web-app/pull/123', pr)).toBe(false);
    expect(showsPage('https://github.com/acme/web-app/pull/1', pr)).toBe(false);
    expect(showsPage('https://github.com/acme/api/pull/12', pr)).toBe(false);
  });

  it('does not match a tab with no address', () => {
    expect(showsPage(undefined, pr)).toBe(false);
  });
});
