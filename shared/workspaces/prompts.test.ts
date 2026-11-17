import { describe, expect, it } from 'vitest';
import { fillPrompt } from './prompts';

describe('fillPrompt', () => {
  const text = '/code-review max PR-URL for PROJ-XXX, ask NAME';

  it('fills the PR url and ticket when known', () => {
    expect(fillPrompt(text, { prUrl: 'https://github.com/o/r/pull/1', ticket: 'PROJ-12' })).toBe(
      '/code-review max https://github.com/o/r/pull/1 for PROJ-12, ask NAME',
    );
  });

  it('leaves a placeholder alone when its value is unknown', () => {
    expect(fillPrompt(text, { prUrl: null, ticket: 'PROJ-12' })).toBe('/code-review max PR-URL for PROJ-12, ask NAME');
    expect(fillPrompt(text, { prUrl: null, ticket: null })).toBe(text);
  });

  it('only replaces standalone placeholders and inserts values literally', () => {
    expect(fillPrompt('PR-URL-1 and PR-URL-2', { prUrl: 'u', ticket: null })).toBe('PR-URL-1 and PR-URL-2');
    expect(fillPrompt('see PR-URL', { prUrl: 'https://x/$&', ticket: null })).toBe('see https://x/$&');
  });

  it('replaces a PR link ending /pull/XXXX with the PR, leaving a real link alone', () => {
    const text = '/code-review - PROJ-XXX - go/no-go @ https://github.com/acme/web-app/pull/XXXX, see also https://github.com/acme/web-app/pull/12';
    expect(fillPrompt(text, { prUrl: 'https://github.com/acme/web-app/pull/482', ticket: 'PROJ-9' })).toBe(
      '/code-review - PROJ-9 - go/no-go @ https://github.com/acme/web-app/pull/482, see also https://github.com/acme/web-app/pull/12',
    );
    expect(fillPrompt(text, { prUrl: null, ticket: null })).toBe(text);
  });
});
