import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, HOST, PORT } from '../helper/src/platform/config';
import { findWorkspace, parseCommand } from './cw-args';

// A command line for the helper's HTTP API: `npm run cw -- new PROJ-123`, or an alias to that.

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
    case 'rm': {
      const found = await workspace(parsed.ref);
      await request('DELETE', `/workspaces/${found.id}`);
      console.log(`Removed ${found.name}`);
      break;
    }
  }
}

main(process.argv.slice(2)).catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
