export interface SetupInput {
  /** launchd runs the helper, so it starts at login and Settings can restart it. */
  managed: boolean;
  /** The extension ID the helper expects, and the one this extension has. */
  helperExtensionId: string;
  extensionId: string;
  /** What the last review-request fetch did; it needs `gh` signed in and GitHub answering. */
  reviews: { fetchedAt: string | null; error: string | null };
  promptsFileExists: boolean;
  /** Which configured repo folders exist. */
  repoRoots: { path: string; exists: boolean }[];
  /** The key bound to the next-workspace command, or '' when none is. */
  switchShortcut: string;
  /** Workspaces created so far. */
  workspaceCount: number;
  /** The hooks that report claude's status are set up, so status dots and activity work. */
  statusHooks: boolean;
  /** Config entries the helper ignored. */
  configProblems: string[];
}

export interface SetupItem {
  id: string;
  label: string;
  ok: boolean;
  /** What is wrong, or what it found. */
  detail: string;
  /** What to do about it. */
  fix?: string;
}

/** What `gh` and the shell say when it is missing or signed out, as opposed to GitHub being slow or down. */
const SIGNED_OUT = /gh auth login|not logged in|command not found|HTTP 401|bad credentials/i;

const firstLine = (error: string) => error.trim().split('\n').pop()!.trim();

/** A failed fetch only means `gh` is signed out when it says so: the helper keeps polling through timeouts and 504s. */
function github({ fetchedAt, error }: SetupInput['reviews']): SetupItem {
  const base = { id: 'github', label: 'GitHub CLI signed in' };
  if (!error) return { ...base, ok: true, detail: fetchedAt ? 'Review requests are loading.' : 'Fetching review requests.' };
  if (SIGNED_OUT.test(error))
    return { ...base, ok: false, detail: 'gh is missing or signed out.', fix: 'Run gh auth login in a terminal, then press ↻ in Review requests.' };
  // Having loaded once proves gh works, so a later failure is GitHub or the network and the next poll retries.
  if (fetchedAt) return { ...base, ok: true, detail: `The last refresh failed (${firstLine(error)}); it retries every 5 minutes.` };
  return {
    ...base,
    ok: false,
    detail: `Review requests could not be loaded: ${firstLine(error)}`,
    fix: 'Press ↻ in Review requests to retry. If it keeps failing, run npm run doctor.',
  };
}

/** What a fresh install needs, each with what to do when it is not so. */
export function buildChecklist(input: SetupInput): SetupItem[] {
  const missingRoots = input.repoRoots.filter((root) => !root.exists).map((root) => root.path);
  return [
    {
      id: 'agent',
      label: 'Helper starts at login',
      ok: input.managed,
      detail: input.managed ? 'Managed by launchd.' : 'The helper was started by hand, so it will not come back after a restart or reboot.',
      fix: input.managed ? undefined : 'Run npm run agent:start in the project folder.',
    },
    {
      id: 'extension',
      label: 'Extension matches the helper',
      ok: input.helperExtensionId === input.extensionId,
      detail:
        input.helperExtensionId === input.extensionId
          ? 'The extension IDs agree.'
          : `The helper expects ${input.helperExtensionId}, but this extension is ${input.extensionId}.`,
      fix: input.helperExtensionId === input.extensionId ? undefined : 'Run npm run setup, then reload the extension.',
    },
    {
      id: 'config',
      label: 'Config file',
      ok: input.configProblems.length === 0,
      detail: input.configProblems.length === 0 ? 'Every entry is understood.' : input.configProblems.join(' '),
      fix: input.configProblems.length === 0 ? undefined : 'Correct ~/.chrome-workspaces/config.json (see docs/configuration.md), then restart the helper.',
    },
    {
      id: 'status-hooks',
      label: 'Status hooks',
      ok: input.statusHooks,
      detail: input.statusHooks
        ? 'Workspaces report when claude is working or waiting.'
        : 'The hook script is missing or Node is older than 22.18, so there are no status dots, waiting counts, notifications, activity or costs.',
      fix: input.statusHooks ? undefined : 'Use Node 22.18 or newer, then run npm run agent:restart. npm run doctor says which is wrong.',
    },
    github(input.reviews),
    {
      id: 'prompts',
      label: 'Prompts file',
      ok: input.promptsFileExists,
      detail: input.promptsFileExists ? 'Found.' : 'From prompt has nothing to pick from.',
      fix: input.promptsFileExists ? undefined : 'Run npm run setup to create a starter, or set promptsFile in the config.',
    },
    {
      id: 'repos',
      label: 'Repo folders',
      ok: input.repoRoots.length > 0 && missingRoots.length === 0,
      detail:
        input.repoRoots.length === 0
          ? 'None are configured, so the Repo picker is empty.'
          : missingRoots.length
            ? `Not found: ${missingRoots.join(', ')}.`
            : 'All found.',
      fix: input.repoRoots.length === 0 || missingRoots.length ? 'Set repoRoots in the config to the folders your repos live in.' : undefined,
    },
    {
      id: 'shortcut',
      label: 'Switch shortcut',
      ok: input.switchShortcut !== '',
      detail: input.switchShortcut ? `Bound to ${input.switchShortcut}.` : 'No key is bound, so only clicking switches workspaces.',
      fix: input.switchShortcut ? undefined : 'Bind it at chrome://extensions/shortcuts.',
    },
    {
      id: 'workspace',
      label: 'First workspace',
      ok: input.workspaceCount > 0,
      detail: input.workspaceCount > 0 ? `${input.workspaceCount} so far.` : 'None yet.',
      fix: input.workspaceCount > 0 ? undefined : 'Press + New workspace.',
    },
  ];
}

export const remaining = (items: readonly SetupItem[]): number => items.filter((item) => !item.ok).length;
