import { existsSync, mkdtempSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ScrollbackStore } from './scrollback-store';

let dir: string;
let store: ScrollbackStore;

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), 'cw-scrollback-')), 'scrollback');
  store = new ScrollbackStore(dir);
});

describe('ScrollbackStore', () => {
  it('hands back what was saved once, in a file only the user can read', () => {
    store.save('ws-0123abcd', 'hello\r\n');
    expect(statSync(join(dir, 'ws-0123abcd.txt')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    expect(store.take('ws-0123abcd')).toBe('hello\r\n');
    expect(store.take('ws-0123abcd')).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps nothing for an empty terminal, and has nothing before the folder exists', () => {
    expect(store.take('ws-0123abcd')).toBeNull();
    store.save('ws-0123abcd', '');
    expect(existsSync(dir)).toBe(false);
    store.prune();
  });

  it('refuses an id that is not a plain file name', () => {
    store.save('../escape', 'x');
    expect(existsSync(dir)).toBe(false);
    expect(store.take('../escape')).toBeNull();
    store.drop('../escape');
  });

  it('drops one session, and prunes those saved over a month ago', () => {
    store.save('ws-00000001', 'a');
    store.save('ws-00000002', 'b');
    store.save('ws-00000003', 'c');
    store.drop('ws-00000001');
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, 'ws-00000002.txt'), old, old);
    store.prune();
    expect(readdirSync(dir)).toEqual(['ws-00000003.txt']);
  });
});
