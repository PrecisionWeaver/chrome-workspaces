#!/usr/bin/env node
// Run by claude on session events (see helper/src/hooks-config.ts), with the event on stdin.
// It must always exit 0: a failing hook would disrupt the session it observes.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { STATUS_BY_EVENT } from '../shared/session-file.ts';
import type { SessionFile } from '../shared/session-file.ts';

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
}

const dir = join(process.env.CW_DATA_DIR || join(homedir(), '.chrome-workspaces'), 'sessions');

try {
  const input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
  const status = input.hook_event_name ? STATUS_BY_EVENT[input.hook_event_name] : undefined;
  // The id becomes a file name, so only a plain one is accepted.
  if (status && input.session_id && /^[A-Za-z0-9_-]+$/.test(input.session_id)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${input.session_id}.json`);
    const now = new Date().toISOString();

    let state: SessionFile = {};
    try {
      state = JSON.parse(readFileSync(file, 'utf8')) as SessionFile;
    } catch {
      // A first event, or a file that is not readable: start again.
    }
    // A (re)start begins a new record, so the newest session of a workspace sorts last.
    if (input.hook_event_name === 'SessionStart') state = { started_at: now };

    // A session resumed before its first SessionStart reached us still gets its fields filled in.
    state.session_id = input.session_id;
    state.started_at ||= now;
    state.cwd ||= input.cwd;
    state.transcript_path ||= input.transcript_path;
    state.cw_workspace_id ||= process.env.CW_WORKSPACE_ID || null;
    if (input.hook_event_name === 'PostToolUse' && input.tool_name?.startsWith('mcp__claude-in-chrome__')) state.browser_at = now;
    state.status = status;
    state.status_since = now;
    state.last_event = input.hook_event_name;

    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tmp, file);
  }
} catch {
  // Never fail the session being observed.
}
process.exit(0);
