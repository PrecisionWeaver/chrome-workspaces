import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOST = '127.0.0.1';
export const PORT = Number(process.env.CW_PORT ?? 4178);
export const DATA_DIR = process.env.CW_DATA_DIR ?? join(homedir(), '.chrome-workspaces');
export const SCROLLBACK_LIMIT = 2_000_000;
export const MC_STATE_DIR = process.env.CMC_STATE_DIR ?? join(homedir(), '.claude-mission-control', 'sessions');

export interface HelperConfig {
  extensionId: string;
  /** Where new workspaces start when no directory is given. */
  defaultCwd: string;
  /** The Obsidian note holding reusable prompts. */
  promptsFile: string;
  /** `owner/name` to the directory PR workspaces for that repo start in. */
  repoDirs: Record<string, string>;
}

const DEFAULT_PROMPTS_FILE = '~/Documents/Websites/obsidian-vault/Patterns/Most Used Prompts.md';

export function loadConfig(): HelperConfig {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8')) as Partial<HelperConfig>;
  if (!raw.extensionId) throw new Error(`${join(DATA_DIR, 'config.json')} has no extensionId; run npm run setup`);
  return {
    extensionId: raw.extensionId,
    defaultCwd: raw.defaultCwd ?? homedir(),
    promptsFile: expandHome(raw.promptsFile ?? DEFAULT_PROMPTS_FILE),
    repoDirs: Object.fromEntries(Object.entries(raw.repoDirs ?? {}).map(([repo, dir]) => [repo, expandHome(dir)])),
  };
}

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
