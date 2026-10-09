import { describe, expect, it } from 'vitest';
import { normalizeJiraBase, ticketUrl } from '../../shared/jira';

describe('normalizeJiraBase', () => {
  it('keeps an https site, dropping trailing slashes, and keeps a path for a Jira that lives under one', () => {
    expect(normalizeJiraBase('https://acme.atlassian.net')).toBe('https://acme.atlassian.net');
    expect(normalizeJiraBase('  https://acme.atlassian.net/// ')).toBe('https://acme.atlassian.net');
    expect(normalizeJiraBase('https://example.com/jira/')).toBe('https://example.com/jira');
  });

  it('refuses anything that is not a plain https origin', () => {
    for (const bad of ['http://acme.atlassian.net', 'javascript:alert(1)', 'https://user:pw@acme.atlassian.net', 'https://acme.atlassian.net?x=1', 'https://acme.atlassian.net#frag', 'acme.atlassian.net', '', 5, null, undefined]) {
      expect(normalizeJiraBase(bad)).toBeNull();
    }
  });
});

describe('ticketUrl', () => {
  const base = 'https://acme.atlassian.net';
  it('builds the browse address for a ticket key', () => {
    expect(ticketUrl(base, 'PROJ-123')).toBe('https://acme.atlassian.net/browse/PROJ-123');
    expect(ticketUrl('https://example.com/jira', 'OPS-7')).toBe('https://example.com/jira/browse/OPS-7');
  });

  it('has nothing without a site, or for something that is not a ticket key', () => {
    expect(ticketUrl(null, 'PROJ-1')).toBeNull();
    expect(ticketUrl(base, null)).toBeNull();
    for (const bad of ['proj-1', 'PROJ-', 'PROJ-1/../../admin', 'PROJ-1?x', 'Fix the bug', '']) expect(ticketUrl(base, bad)).toBeNull();
  });
});
