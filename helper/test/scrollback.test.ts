import { describe, expect, it } from 'vitest';
import { Scrollback } from '../src/scrollback';

describe('Scrollback', () => {
  it('returns everything pushed while under the limit', () => {
    const buffer = new Scrollback(100);
    buffer.push('hello ');
    buffer.push('world');
    expect(buffer.snapshot()).toBe('hello world');
  });

  it('drops whole chunks from the front once over the limit', () => {
    const buffer = new Scrollback(6);
    buffer.push('abc');
    buffer.push('def');
    buffer.push('ghi');
    expect(buffer.snapshot()).toBe('defghi');
  });

  it('trims a partial chunk so exactly the newest `limit` characters remain', () => {
    const buffer = new Scrollback(4);
    buffer.push('abcdef');
    expect(buffer.snapshot()).toBe('cdef');
  });

  it('is empty before anything is pushed', () => {
    expect(new Scrollback(10).snapshot()).toBe('');
  });
});
