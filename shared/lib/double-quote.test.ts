import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { doubleQuote } from './double-quote';

describe('doubleQuote', () => {
  it('leaves an ordinary path as it was, in quotes', () => {
    expect(doubleQuote('/Users/me/code/chrome workspaces')).toBe('"/Users/me/code/chrome workspaces"');
  });

  it('keeps a quote, a dollar sign, a backtick and a backslash inside the word', () => {
    const awkward = 'a"b$HOME`id`c\\d';
    expect(doubleQuote(awkward)).toBe('"a\\"b\\$HOME\\`id\\`c\\\\d"');
    expect(execFileSync('sh', ['-c', `printf %s ${doubleQuote(awkward)}`], { encoding: 'utf8' })).toBe(awkward);
  });
});
