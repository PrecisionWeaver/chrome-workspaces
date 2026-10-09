import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseListening, parsePs, pathBytes, readProcesses, subtree } from '../src/system';

const PS = `
    1     0  0.0  1000 10-02:03:04 /sbin/launchd
  100     1  1.5  2000       01:02 -zsh
  101   100 12.0 90000       00:30 node /repo/node_modules/.bin/vite --port 5173
  102   101  0.1  4000       00:29 esbuild --service
  200     1  0.0  1000       00:10 unrelated process
garbage line
`;

describe('parsePs', () => {
  it('reads pid, parent, cpu, memory, elapsed time and the whole command, skipping junk', () => {
    const procs = parsePs(PS);
    expect(procs).toHaveLength(5);
    expect(procs[2]).toEqual({ pid: 101, ppid: 100, cpu: 12, rssKb: 90000, elapsed: '00:30', command: 'node /repo/node_modules/.bin/vite --port 5173' });
    expect(procs[0].elapsed).toBe('10-02:03:04');
  });
});

describe('subtree', () => {
  it('returns a process and everything beneath it, parents first, and nothing else', () => {
    expect(subtree(parsePs(PS), 100).map((p) => p.pid)).toEqual([100, 101, 102]);
    expect(subtree(parsePs(PS), 200).map((p) => p.pid)).toEqual([200]);
  });

  it('is empty for a process that is gone, and survives a parent loop', () => {
    expect(subtree(parsePs(PS), 999)).toEqual([]);
    const loop = [
      { pid: 1, ppid: 2, cpu: 0, rssKb: 0, elapsed: '0', command: 'a' },
      { pid: 2, ppid: 1, cpu: 0, rssKb: 0, elapsed: '0', command: 'b' },
    ];
    expect(subtree(loop, 1).map((p) => p.pid)).toEqual([1, 2]);
  });
});

describe('parseListening', () => {
  it('collects each pid\'s ports from IPv4, IPv6 and wildcard addresses once', () => {
    const out = 'p101\nf20\nn*:5173\nf21\nn[::1]:5173\np300\nn127.0.0.1:8000\nn[::]:8001\n';
    expect([...parseListening(out)]).toEqual([
      [101, [5173]],
      [300, [8000, 8001]],
    ]);
  });
});

describe('real processes and paths', () => {
  it('finds this process in the live process list', async () => {
    const procs = await readProcesses();
    expect(procs.find((p) => p.pid === process.pid)?.command).toContain('node');
    expect(subtree(procs, process.ppid).map((p) => p.pid)).toContain(process.pid);
  });

  it('adds up a folder\'s bytes, and is 0 for a path that is not there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-size-'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'a'), '12345');
    writeFileSync(join(dir, 'sub', 'b'), '123');
    expect(pathBytes(dir)).toBe(8);
    expect(pathBytes(join(dir, 'missing'))).toBe(0);
  });
});
