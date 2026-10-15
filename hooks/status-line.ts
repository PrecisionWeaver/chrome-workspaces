#!/usr/bin/env node
// Run by claude as the status line of a workspace's session (see helper/src/hooks-config.ts), with its JSON on stdin.
// It keeps the plan's rate limits for Settings, then runs the status line the person already had, so what they see is unchanged.
// It must always exit 0 and print only what that command prints.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mergeRateLimits, PLAN_USAGE_FILE } from '../shared/plan-usage.ts';

const dataDir = process.env.CW_DATA_DIR || join(homedir(), '.chrome-workspaces');
const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const COMMAND_TIMEOUT_MS = 5000;

let input = '';
try {
  input = readFileSync(0, 'utf8');
  const { rate_limits } = JSON.parse(input) as { rate_limits?: unknown };
  if (rate_limits) {
    const file = join(dataDir, PLAN_USAGE_FILE);
    let saved: unknown = null;
    try {
      saved = (JSON.parse(readFileSync(file, 'utf8')) as { rate_limits?: unknown }).rate_limits;
    } catch {
      // A first message, or a file that is not readable: start again.
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ saved_at: new Date().toISOString(), rate_limits: mergeRateLimits(saved, rate_limits) }, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }
} catch {
  // Never fail the session being observed.
}

try {
  const settings = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')) as { statusLine?: { type?: string; command?: string } };
  const command = settings.statusLine?.type === 'command' ? settings.statusLine.command : undefined;
  if (command) spawnSync('sh', ['-c', command], { input, stdio: ['pipe', 'inherit', 'inherit'], timeout: COMMAND_TIMEOUT_MS });
} catch {
  // No status line of their own, so there is nothing to show.
}
process.exit(0);
