import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SystemProcess } from '../../shared/protocol';

const execFileAsync = promisify(execFile);

const COMMAND_LENGTH = 200;

export interface Proc {
  pid: number;
  ppid: number;
  cpu: number;
  rssKb: number;
  elapsed: string;
  command: string;
}

/** Parses `ps -axo pid=,ppid=,pcpu=,rss=,etime=,command=`. */
export function parsePs(output: string): Proc[] {
  const procs: Proc[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), rssKb: Number(m[4]), elapsed: m[5], command: m[6].slice(0, COMMAND_LENGTH) });
  }
  return procs;
}

/** The process and everything beneath it, parents before children; empty when it is not running. */
export function subtree(procs: readonly Proc[], rootPid: number): Proc[] {
  const byParent = new Map<number, Proc[]>();
  for (const proc of procs) byParent.set(proc.ppid, [...(byParent.get(proc.ppid) ?? []), proc]);
  const root = procs.find((p) => p.pid === rootPid);
  if (!root) return [];
  const result: Proc[] = [];
  const seen = new Set<number>();
  const visit = (proc: Proc): void => {
    if (seen.has(proc.pid)) return;
    seen.add(proc.pid);
    result.push(proc);
    for (const child of byParent.get(proc.pid) ?? []) visit(child);
  };
  visit(root);
  return result;
}

/** Parses `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: a `p<pid>` line, then an `n<address>:<port>` line per socket. */
export function parseListening(output: string): Map<number, number[]> {
  const ports = new Map<number, number[]>();
  let pid: number | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid !== null) {
      const port = Number(line.match(/:(\d+)$/)?.[1]);
      if (port && !(ports.get(pid) ?? []).includes(port)) ports.set(pid, [...(ports.get(pid) ?? []), port]);
    }
  }
  return ports;
}

export async function readProcesses(): Promise<Proc[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,command='], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
  return parsePs(stdout);
}

/** Listening sockets by pid; empty if `lsof` is unavailable or slow, since ports are a nicety. */
export async function readListening(): Promise<Map<number, number[]>> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    return parseListening(stdout);
  } catch (error) {
    // lsof exits 1 when nothing matches but still prints what it found.
    const { stdout } = error as { stdout?: string };
    return stdout ? parseListening(stdout) : new Map();
  }
}

export function toSystemProcess(proc: Proc, listening: ReadonlyMap<number, number[]>): SystemProcess {
  return { pid: proc.pid, ppid: proc.ppid, command: proc.command, cpu: proc.cpu, rssKb: proc.rssKb, elapsed: proc.elapsed, ports: (listening.get(proc.pid) ?? []).sort((a, b) => a - b) };
}

/** Bytes under a path, or the file's own size; 0 if it does not exist. */
export function pathBytes(path: string): number {
  try {
    const info = statSync(path);
    if (!info.isDirectory()) return info.size;
    return readdirSync(path).reduce((total, name) => total + pathBytes(join(path, name)), 0);
  } catch {
    return 0;
  }
}

export const exists = existsSync;
