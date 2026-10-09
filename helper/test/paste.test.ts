import { describe, expect, it } from 'vitest';
import { asPaste, MAX_PASTE_LENGTH, sanitizePaste } from '../src/paste';

describe('sanitizePaste', () => {
  it('keeps ordinary text, newlines and tabs, and turns carriage returns into newlines', () => {
    expect(sanitizePaste('line one\r\nline two\r\tindented\ttab')).toBe('line one\nline two\n\tindented\ttab');
    expect(sanitizePaste('héllo ✓ 日本語')).toBe('héllo ✓ 日本語');
  });

  it('removes escape sequences, so text cannot end a bracketed paste and run as commands', () => {
    const hostile = 'harmless\x1b[201~; rm -rf ~ #\x1b[200~';
    const cleaned = sanitizePaste(hostile);
    expect(cleaned).not.toContain('\x1b');
    expect(cleaned).toBe('harmless[201~; rm -rf ~ #[200~');
  });

  it('removes other control characters: null, backspace, bell, delete and C1 controls', () => {
    expect(sanitizePaste('a\x00b\x08c\x07d\x7fe\x9bf')).toBe('abcdef');
  });

  it('removes the unicode line and paragraph separators', () => {
    expect(sanitizePaste(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`)).toBe('abc');
  });

  it('cuts a very long paste', () => {
    expect(sanitizePaste('x'.repeat(MAX_PASTE_LENGTH + 50))).toHaveLength(MAX_PASTE_LENGTH);
  });
});

describe('asPaste', () => {
  it('wraps the cleaned text in bracketed-paste markers, with no trailing newline that would submit it', () => {
    expect(asPaste('git status')).toBe('\x1b[200~git status\x1b[201~');
    expect(asPaste('a\x1b[201~b')).toBe('\x1b[200~a[201~b\x1b[201~');
  });
});
