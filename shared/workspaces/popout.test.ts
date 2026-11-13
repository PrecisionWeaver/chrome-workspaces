import { describe, expect, it } from 'vitest';
import { findPopout, popoutUrl, popoutWorkspaceId } from './popout';

const BASE = 'chrome-extension://abc/';

describe('popoutUrl and popoutWorkspaceId', () => {
  it('round-trips a workspace id', () => {
    expect(popoutWorkspaceId(popoutUrl(BASE, 'acme-app_1'))).toBe('acme-app_1');
  });

  it('rejects other pages, a missing id, an invalid id and a non-URL', () => {
    expect(popoutWorkspaceId(`${BASE}panel.html?ws=abc`)).toBeNull();
    expect(popoutWorkspaceId(`${BASE}popout.html`)).toBeNull();
    expect(popoutWorkspaceId(`${BASE}popout.html?ws=a%2Fb`)).toBeNull();
    expect(popoutWorkspaceId(`${BASE}popout.html?ws=${'a'.repeat(65)}`)).toBeNull();
    expect(popoutWorkspaceId('not a url')).toBeNull();
  });
});

describe('findPopout', () => {
  const windows = [
    { id: 1, tabs: [{ url: 'https://example.com/' }] },
    { id: 2, tabs: [{ url: popoutUrl(BASE, 'one') }] },
    { id: 3, tabs: [{ url: popoutUrl(BASE, 'two') }] },
    { id: 4 },
  ];

  it('finds the window showing that workspace', () => {
    expect(findPopout(windows, BASE, 'two')?.id).toBe(3);
  });

  it('returns undefined when none shows it', () => {
    expect(findPopout(windows, BASE, 'three')).toBeUndefined();
  });
});
