import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tailLines } from './tail';

const file = (content: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), 'cw-tail-')), 'log.jsonl');
  writeFileSync(path, content);
  return path;
};

describe('tailLines', () => {
  it('returns every line, oldest first, when the file fits in the budget', () => {
    expect(tailLines(file('one\ntwo\nthree\n'), 1024)).toEqual(['one', 'two', 'three', '']);
  });

  it('drops the partial line a mid-file tail starts with', () => {
    // The last 9 bytes are "wo\nthree\n": "wo" is the tail of a line that was cut, so it goes.
    expect(tailLines(file('one\ntwo\nthree\n'), 9)).toEqual(['three', '']);
  });

  it('keeps a first line that the budget happens to start on exactly', () => {
    // A budget that lands on a line boundary still cannot know the line is whole, so it is dropped too.
    expect(tailLines(file('one\ntwo\nthree\n'), 10)).toEqual(['three', '']);
  });

  it('reads an empty file as one empty line', () => {
    expect(tailLines(file(''), 1024)).toEqual(['']);
  });

  it('returns null for a file that cannot be read', () => {
    expect(tailLines(join(tmpdir(), 'cw-tail-missing', 'nope.jsonl'), 1024)).toBeNull();
  });
});
