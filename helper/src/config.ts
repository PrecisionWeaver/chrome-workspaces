import { readFileSync } from 'node:fs';
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
}

export function loadConfig(): HelperConfig {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8')) as Partial<HelperConfig>;
  if (!raw.extensionId) throw new Error(`${join(DATA_DIR, 'config.json')} has no extensionId; run npm run setup`);
  return { extensionId: raw.extensionId, defaultCwd: raw.defaultCwd ?? homedir() };
}
