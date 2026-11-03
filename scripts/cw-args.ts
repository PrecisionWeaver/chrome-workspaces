/** The command line of scripts/cw.ts, kept apart from the requests so it can be tested. */

export interface CreateBody {
  name?: string;
  cwd?: string;
  url?: string;
  prompt?: string;
  pr?: string;
  worktree?: string;
}

export type Command =
  | { command: 'list' }
  | { command: 'new'; body: CreateBody }
  | { command: 'focus' | 'rm'; ref: string }
  | { command: 'send'; ref: string; text: string }
  | { error: string };

export const usage = [
  'Usage: cw <command>',
  '  list                                   every workspace and its status',
  '  new <name> [--cwd DIR] [--url URL] [--prompt TEXT] [--worktree BRANCH]',
  '  new --pr URL [--prompt TEXT]           a workspace for a pull request',
  '  focus <workspace>                      switch Chrome to it',
  '  send <workspace> <text...>             paste text into its terminal (not submitted)',
  '  rm <workspace>                         end its session and remove it',
  'A workspace is its id, ticket or name.',
].join('\n');

const OPTIONS: Record<string, keyof CreateBody> = { '--cwd': 'cwd', '--url': 'url', '--prompt': 'prompt', '--pr': 'pr', '--worktree': 'worktree' };

export function parseCommand(argv: readonly string[]): Command {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
      return { error: usage };
    case 'list':
      return { command: 'list' };
    case 'new': {
      const body: CreateBody = {};
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg.startsWith('--')) {
          const key = OPTIONS[arg];
          if (!key) return { error: `Unknown option "${arg}".` };
          const value = rest[++i];
          if (value === undefined) return { error: `${arg} needs a value.` };
          body[key] = value;
        } else if (body.name === undefined) body.name = arg;
        else return { error: `Unexpected argument "${arg}".` };
      }
      if (!body.name && !body.pr) return { error: 'new needs a name, or --pr.' };
      return { command: 'new', body };
    }
    case 'focus':
    case 'rm':
      if (!rest[0]) return { error: `${command} needs a workspace: its id, name or ticket.` };
      return { command, ref: rest[0] };
    case 'send': {
      if (!rest[0]) return { error: 'send needs a workspace: its id, name or ticket.' };
      const text = rest.slice(1).join(' ');
      if (!text) return { error: 'send needs text after the workspace.' };
      return { command: 'send', ref: rest[0], text };
    }
    default:
      return { error: `Unknown command "${command}".\n${usage}` };
  }
}

/** The workspace a person meant: by id, else ticket, else name, case ignored. */
export function findWorkspace<T extends { id: string; name: string; ticket: string | null }>(list: readonly T[], ref: string): T | undefined {
  const wanted = ref.toLowerCase();
  return list.find((ws) => ws.id === ref) ?? list.find((ws) => ws.ticket?.toLowerCase() === wanted) ?? list.find((ws) => ws.name.toLowerCase() === wanted);
}
