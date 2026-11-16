import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StatCache } from './stat-cache';

function file(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cw-stat-')), 'a.txt');
  writeFileSync(path, content);
  return path;
}

describe('StatCache', () => {
  it('computes once while the file is unchanged, and again when its size or time changes', () => {
    const path = file('one');
    const cache = new StatCache<number>();
    let calls = 0;
    const read = () => cache.get(path, () => ++calls);
    expect([read(), read()]).toEqual([1, 1]);
    writeFileSync(path, 'three');
    expect(read()).toBe(2);
    const later = Date.now() / 1000 + 60;
    utimesSync(path, later, later);
    expect(read()).toBe(3);
  });

  it('keeps separate values for separate keys on one file', () => {
    const path = file('x');
    const cache = new StatCache<string>();
    expect([cache.get(path, () => 'a', 'a'), cache.get(path, () => 'b', 'b'), cache.get(path, () => 'unused', 'a')]).toEqual(['a', 'b', 'a']);
  });

  it('does not remember a file that cannot be read', () => {
    const path = file('x');
    const cache = new StatCache<number>();
    let calls = 0;
    cache.get(path, () => ++calls);
    rmSync(path);
    expect([cache.get(path, () => ++calls), cache.get(path, () => ++calls)]).toEqual([2, 3]);
  });

  it('computes again once an entry is older than the age it was given', () => {
    const path = file('x');
    const cache = new StatCache<number>(1000);
    let calls = 0;
    const at = (now: number) => cache.get(path, () => ++calls, path, now);
    expect([at(0), at(999), at(1000)]).toEqual([1, 1, 2]);
  });

  it('drops the oldest entry past its limit', () => {
    const path = file('x');
    const cache = new StatCache<number>(Number.POSITIVE_INFINITY, 2);
    let calls = 0;
    for (const key of ['a', 'b', 'c']) cache.get(path, () => ++calls, key);
    cache.get(path, () => ++calls, 'a');
    expect(calls).toBe(4);
  });
});
