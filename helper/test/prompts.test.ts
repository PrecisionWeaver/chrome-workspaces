import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillPrompt } from '../../shared/prompts';
import { parsePrompts, readPrompts } from '../src/prompts';

const NOTE = [
  '- loose prompt',
  '**Reviews**',
  ' - /code-review - PROJ-XXX - go/no-go',
  '- Is this code dry?',
  '  ',
  '**PR Comments / Feedback**  ',
  '- /pr-comments PR-URL',
  'Some prose that is not a prompt',
  '-',
].join('\n');

describe('parsePrompts', () => {
  it('reads each bullet as a prompt under the bold heading above it', () => {
    expect(parsePrompts(NOTE)).toEqual([
      { section: '', text: 'loose prompt' },
      { section: 'Reviews', text: '/code-review - PROJ-XXX - go/no-go' },
      { section: 'Reviews', text: 'Is this code dry?' },
      { section: 'PR Comments / Feedback', text: '/pr-comments PR-URL' },
    ]);
  });

  it('reads the note from disk on every call', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cw-prompts-')), 'prompts.md');
    writeFileSync(file, '**A**\n- one');
    expect(readPrompts(file)).toEqual([{ section: 'A', text: 'one' }]);
    writeFileSync(file, '**A**\n- two');
    expect(readPrompts(file)).toEqual([{ section: 'A', text: 'two' }]);
  });

  it('throws, naming the file, when it cannot be read', () => {
    expect(() => readPrompts('/nonexistent/prompts.md')).toThrow('/nonexistent/prompts.md');
  });
});

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
