import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LIMITS, type Limits } from '../../shared/guardrails';
import { normalizeJiraBase } from '../../shared/jira';
import { mergePricing, type Pricing } from '../../shared/pricing';
import { MODEL_PATTERN } from '../../shared/protocol';

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.CW_PORT ?? 4178);
export const DATA_DIR = process.env.CW_DATA_DIR ?? join(homedir(), '.chrome-workspaces');
export const SCROLLBACK_LIMIT = 2_000_000;
export const MC_STATE_DIR = process.env.CMC_STATE_DIR ?? join(homedir(), '.claude-mission-control', 'sessions');

export interface HelperConfig {
  extensionId: string;
  /** Where new workspaces start when no directory is given. */
  defaultCwd: string;
  /** A markdown note holding reusable prompts. */
  promptsFile: string;
  /** `claude --model` for workspaces that pick none; unset leaves it to claude. */
  defaultModel: string | null;
  /** When Settings warns about a workspace using a lot of memory, or a server left running. */
  limits: Limits;
  /** A Jira site, e.g. `https://acme.atlassian.net`, so tickets can be opened; unset hides the links. */
  jiraBaseUrl: string | null;
  /** Dollars per million tokens by model family, for the cost estimates. */
  pricing: Pricing;
  /** Folders whose git repos can be picked as the start of a new workspace. */
  repoRoots: string[];
  /** `owner/name` to the directory PR workspaces for that repo start in. */
  repoDirs: Record<string, string>;
  /** `owner/name` repos whose open PRs all show as review requests, requested or not. */
  watchRepos: string[];
}

const DEFAULT_PROMPTS_FILE = '~/.chrome-workspaces/prompts.md';

const DEFAULT_REPO_ROOTS = ['~/Documents/Websites', '~/Herd'];

export function loadConfig(): HelperConfig {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8')) as Partial<HelperConfig>;
  if (!raw.extensionId) throw new Error(`${join(DATA_DIR, 'config.json')} has no extensionId; run npm run setup`);
  return {
    extensionId: raw.extensionId,
    defaultCwd: raw.defaultCwd ?? homedir(),
    promptsFile: expandHome(raw.promptsFile ?? DEFAULT_PROMPTS_FILE),
    defaultModel: raw.defaultModel && MODEL_PATTERN.test(raw.defaultModel) ? raw.defaultModel : null,
    jiraBaseUrl: normalizeJiraBase((raw as { jiraBaseUrl?: unknown }).jiraBaseUrl),
    pricing: mergePricing((raw as { pricing?: unknown }).pricing),
    limits: {
      memoryWarnMb: positive(raw.limits?.memoryWarnMb) ?? DEFAULT_LIMITS.memoryWarnMb,
      idleServerHours: positive(raw.limits?.idleServerHours) ?? DEFAULT_LIMITS.idleServerHours,
    },
    repoRoots: (raw.repoRoots ?? DEFAULT_REPO_ROOTS).map(expandHome),
    repoDirs: Object.fromEntries(Object.entries(raw.repoDirs ?? {}).map(([repo, dir]) => [repo, expandHome(dir)])),
    watchRepos: raw.watchRepos ?? [],
  };
}

const positive = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
