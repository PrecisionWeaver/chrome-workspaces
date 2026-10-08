import { describe, expect, it } from 'vitest';
import { parseTabUrls } from '../../shared/tab-urls';

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
