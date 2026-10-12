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
/** The launchd label the helper runs under; setup writes the matching plist. */
export const AGENT_LABEL = 'com.chrome-workspaces.helper';
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
  /** The command that starts claude, e.g. a wrapper that passes claude's arguments through. */
  claudeCommand: string;
  /** Config entries that were ignored, and why, so Settings and the log can say so. */
  problems: string[];
}

const DEFAULT_PROMPTS_FILE = '~/.chrome-workspaces/prompts.md';

const KNOWN_KEYS = new Set(['extensionId', 'defaultCwd', 'promptsFile', 'defaultModel', 'limits', 'jiraBaseUrl', 'pricing', 'repoRoots', 'repoDirs', 'watchRepos', 'claudeCommand']);
// Repo names reach a `gh` command line, so only plain `owner/name` is accepted.
const REPO_NAME = /^[\w.-]+\/[\w.-]+$/;
// The command is interpolated into the launch line, so it must be a bare command name.
const COMMAND_NAME = /^[\w.+-]{1,64}$/;

export function loadConfig(): HelperConfig {
  const file = join(DATA_DIR, 'config.json');
  return parseConfig(readFileSync(file, 'utf8'), file);
}

/** Reads config text. A missing extensionId or unreadable JSON is fatal; any other bad entry is dropped and named in `problems`. */
export function parseConfig(text: string, file: string): HelperConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${file} must hold a JSON object`);
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.extensionId !== 'string' || !raw.extensionId) throw new Error(`${file} has no extensionId; run npm run setup`);

  const problems = Object.keys(raw)
    .filter((key) => !KNOWN_KEYS.has(key))
    .map((key) => `Unknown key "${key}" is ignored.`);
  const string = (key: string): string | null => {
    const value = raw[key];
    if (value === undefined || value === null) return null;
    if (typeof value === 'string') return value;
    problems.push(`${key} must be a string.`);
    return null;
  };
  const stringList = (key: string, valid: (item: string) => boolean = () => true): string[] | null => {
    const value = raw[key];
    if (value === undefined) return null;
    if (!Array.isArray(value)) {
      problems.push(`${key} must be a list.`);
      return null;
    }
    return value.filter((item): item is string => {
      const ok = typeof item === 'string' && valid(item);
      if (!ok) problems.push(`${key} entry ${JSON.stringify(item)} is ignored.`);
      return ok;
    });
  };
  const isRepo = (repo: string) => REPO_NAME.test(repo);

  const defaultModel = string('defaultModel');
  if (defaultModel && !MODEL_PATTERN.test(defaultModel)) problems.push(`defaultModel "${defaultModel}" is not a model name, so it is ignored.`);
  const jiraBaseUrl = normalizeJiraBase(raw.jiraBaseUrl);
  if (raw.jiraBaseUrl !== undefined && raw.jiraBaseUrl !== null && !jiraBaseUrl) problems.push('jiraBaseUrl must be an https address, so it is ignored.');
  const claudeCommand = string('claudeCommand');
  if (claudeCommand && !COMMAND_NAME.test(claudeCommand)) problems.push(`claudeCommand "${claudeCommand}" must be a bare command name, so claude is used.`);

  const repoDirs: Record<string, string> = {};
  if (raw.repoDirs !== undefined) {
    if (typeof raw.repoDirs !== 'object' || raw.repoDirs === null || Array.isArray(raw.repoDirs)) problems.push('repoDirs must map owner/name to a folder.');
    else
      for (const [repo, dir] of Object.entries(raw.repoDirs)) {
        if (isRepo(repo) && typeof dir === 'string') repoDirs[repo] = expandHome(dir);
        else problems.push(`repoDirs entry "${repo}" is ignored: it needs an owner/name key and a folder.`);
      }
  }
  const limits = (typeof raw.limits === 'object' && raw.limits !== null ? raw.limits : {}) as Partial<Limits>;

  return {
    extensionId: raw.extensionId,
    defaultCwd: string('defaultCwd') ?? homedir(),
    promptsFile: expandHome(string('promptsFile') ?? DEFAULT_PROMPTS_FILE),
    defaultModel: defaultModel && MODEL_PATTERN.test(defaultModel) ? defaultModel : null,
    jiraBaseUrl,
    pricing: mergePricing(raw.pricing),
    limits: {
      memoryWarnMb: positive(limits.memoryWarnMb) ?? DEFAULT_LIMITS.memoryWarnMb,
      idleServerHours: positive(limits.idleServerHours) ?? DEFAULT_LIMITS.idleServerHours,
    },
    repoRoots: (stringList('repoRoots') ?? []).map(expandHome),
    repoDirs,
    watchRepos: stringList('watchRepos', isRepo) ?? [],
    claudeCommand: claudeCommand && COMMAND_NAME.test(claudeCommand) ? claudeCommand : 'claude',
    problems,
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
