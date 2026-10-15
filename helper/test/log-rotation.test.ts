import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rotateLog } from '../src/log-rotation';

describe('rotateLog', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-log-'));
    file = join(dir, 'helper.log');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('leaves a small log alone', () => {
    writeFileSync(file, 'short');
    expect(rotateLog(file, 100)).toBe(false);
    expect(readFileSync(file, 'utf8')).toBe('short');
    expect(existsSync(`${file}.1`)).toBe(false);
  });

  it('keeps the old output in .1 and empties the log in place', () => {
    writeFileSync(file, 'x'.repeat(200));
    expect(rotateLog(file, 100)).toBe(true);
    expect(statSync(file).size).toBe(0);
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('x'.repeat(200));
  });

  it('replaces the previous generation', () => {
    writeFileSync(`${file}.1`, 'older');
    writeFileSync(file, 'y'.repeat(200));
    rotateLog(file, 100);
    expect(readFileSync(`${file}.1`, 'utf8')).toBe('y'.repeat(200));
  });

  it('does nothing when there is no log', () => {
    expect(rotateLog(file, 100)).toBe(false);
  });
});
