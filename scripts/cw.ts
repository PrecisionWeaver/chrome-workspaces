import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, HOST, PORT } from '../helper/src/platform/config';
import { findWorkspace, parseCommand } from './cw-args';

// A command line for the helper's HTTP API: `cw new PROJ-123` once `npm link` has put bin/cw.mjs on the PATH, or `npm run cw -- new PROJ-123`.

interface Listed {
  id: string;
  name: string;
  ticket: string | null;
  cwd: string;
}

function token(): string {
  try {
    return readFileSync(join(DATA_DIR, 'token'), 'utf8').trim();
  } catch {
    throw new Error(`No token at ${join(DATA_DIR, 'token')}: run npm run install-app first.`);
  }
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://${HOST}:${PORT}${path}`, {
    method,
    headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch(() => {
    throw new Error(`The helper is not listening on ${HOST}:${PORT}. Is it running?`);
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function workspace(ref: string): Promise<Listed> {
  const { workspaces } = (await request('GET', '/workspaces')) as { workspaces: Listed[] };
  const found = findWorkspace(workspaces, ref);
  if (!found) throw new Error(`No workspace is called ${ref}.`);
  return found;
}

async function archived(ref: string): Promise<Listed> {
  const { entries } = (await request('GET', '/archived')) as { entries: Listed[] };
  const found = findWorkspace(entries, ref);
  if (!found) throw new Error(`No archived workspace is called ${ref}.`);
  return found;
}

interface Turn {
  status: string | null;
  waiting: { type: string; message: string } | null;
  timedOut?: boolean;
}

function describe(name: string, { status, waiting }: Turn): string {
  if (status === 'needs_input') return `${name} is waiting on you${waiting?.message ? `: ${waiting.message}` : ''}`;
  if (status === 'working') return `${name} is working`;
  if (status === 'idle') return `${name} is idle`;
  return `${name} has no claude session yet`;
}

// Node's fetch gives up on a response that takes five minutes, so a long wait is asked for in shorter ones.
const WAIT_SLICE_SECONDS = 120;

async function wait(found: Listed, timeoutSeconds: number): Promise<Turn> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  for (;;) {
    const left = Math.max(0, (deadline - Date.now()) / 1000);
    const turn = (await request('GET', `/workspaces/${found.id}/wait?timeout=${Math.min(left, WAIT_SLICE_SECONDS)}`)) as Turn;
    if (!turn.timedOut || left <= WAIT_SLICE_SECONDS) return turn;
  }
}

async function main(argv: string[]): Promise<void> {
  const parsed = parseCommand(argv);
  if ('error' in parsed) throw new Error(parsed.error);
  switch (parsed.command) {
    case 'list': {
      const { workspaces, statuses } = (await request('GET', '/workspaces')) as { workspaces: Listed[]; statuses: Record<string, string | null> };
      for (const ws of workspaces)
        console.log(`${ws.id}  ${(statuses[ws.id] ?? '-').padEnd(11)} ${ws.name}${ws.ticket && ws.ticket !== ws.name ? ` (${ws.ticket})` : ''}  ${ws.cwd}`);
      break;
    }
    case 'new': {
      const { workspace: made, created } = (await request('POST', '/workspaces', parsed.body)) as { workspace: Listed; created: boolean };
      console.log(`${created ? 'Created' : 'Focused'} ${made.name} (${made.id}) in ${made.cwd}`);
      break;
    }
    case 'focus': {
      const found = await workspace(parsed.ref);
      await request('POST', `/workspaces/${found.id}/focus`);
      console.log(`Focused ${found.name}`);
      break;
    }
    case 'send': {
      const found = await workspace(parsed.ref);
      await request('POST', `/workspaces/${found.id}/send`, { text: parsed.text });
      console.log(`Pasted into ${found.name}; press Enter there to send it.`);
      break;
    }
    case 'status': {
      const found = await workspace(parsed.ref);
      console.log(describe(found.name, (await request('GET', `/workspaces/${found.id}`)) as Turn));
      break;
    }
    case 'wait': {
      const found = await workspace(parsed.ref);
      const turn = await wait(found, parsed.timeoutSeconds);
      console.log(describe(found.name, turn));
      // A script chaining on this must be able to tell a timeout from a finished turn.
      if (turn.timedOut) process.exitCode = 2;
      break;
    }
    case 'rm': {
      const found = await workspace(parsed.ref);
      await request('DELETE', `/workspaces/${found.id}`);
      console.log(`Archived ${found.name}; cw restore ${found.name} brings it back.`);
      break;
    }
    case 'archived': {
      const { entries } = (await request('GET', '/archived')) as { entries: (Listed & { closedAt: string })[] };
      for (const entry of entries)
        console.log(
          `${entry.id}  ${entry.closedAt.slice(0, 10)}  ${entry.name}${entry.ticket && entry.ticket !== entry.name ? ` (${entry.ticket})` : ''}  ${entry.cwd}`,
        );
      break;
    }
    case 'restore': {
      const found = await archived(parsed.ref);
      const { workspace: restored } = (await request('POST', `/archived/${found.id}/restore`)) as { workspace: Listed };
      console.log(`Restored ${restored.name} (${restored.id}) in ${restored.cwd}`);
      break;
    }
  }
}

main(process.argv.slice(2)).catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
