#!/usr/bin/env node
// Run by claude on session events (see helper/src/hooks-config.ts), with the event on stdin.
// It must always exit 0: a failing hook would disrupt the session it observes.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ACTIVITY_EVENTS, type ActivityEvent, type ActivityEventName } from '../shared/sessions/activity.ts';
import { notificationWaits, STATUS_BY_EVENT } from '../shared/protocol/session-file.ts';
import type { SessionFile } from '../shared/protocol/session-file.ts';
import { describeTool, oneLine } from '../shared/sessions/timeline.ts';

interface HookInput {
  hook_event_name?: string;
  session_id?: string;
  prompt_id?: string;
  agent_id?: string;
  agent_type?: string;
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  prompt?: string;
  trigger?: string;
  notification_type?: string;
  message?: string;
}

const dir = join(process.env.CW_DATA_DIR || join(homedir(), '.chrome-workspaces'), 'sessions');
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** One line for the activity view: who did what, with the tool call in a sentence rather than its whole input. */
function activityLine(input: HookInput, now: string): ActivityEvent {
  const line: ActivityEvent = { at: now, event: input.hook_event_name as ActivityEventName };
  if (str(input.prompt_id)) line.promptId = input.prompt_id;
  if (str(input.agent_id)) line.agentId = input.agent_id;
  if (str(input.agent_type)) line.agentType = input.agent_type;
  if (str(input.tool_name)) {
    line.tool = input.tool_name;
    const toolInput = typeof input.tool_input === 'object' && input.tool_input !== null ? (input.tool_input as Record<string, unknown>) : {};
    const { summary, file } = describeTool(input.tool_name as string, toolInput);
    if (summary) line.summary = summary;
    const subagent = str(toolInput.subagent_type);
    if (subagent) line.subagentType = subagent;
    if (file) line.file = file;
  }
  if (str(input.tool_use_id)) line.toolUseId = input.tool_use_id;
  if (input.hook_event_name === 'UserPromptSubmit' && str(input.prompt)) line.summary = oneLine(input.prompt as string);
  if (input.hook_event_name === 'PreCompact' && str(input.trigger)) line.summary = input.trigger;
  return line;
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8')) as HookInput;
  const event = input.hook_event_name;
  // A notification that only reports something changes nothing: claude is still doing what it was.
  // Nor does a subagent's own tool call: it can arrive after claude's Stop, and would leave an idle session working for good.
  const status =
    event && !(input.agent_id && event !== 'Notification') && (event !== 'Notification' || notificationWaits(input.notification_type))
      ? STATUS_BY_EVENT[event]
      : undefined;
  // The id becomes a file name, so only a plain one is accepted.
  if (event && (status || ACTIVITY_EVENTS.has(event)) && input.session_id && /^[A-Za-z0-9_-]+$/.test(input.session_id)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${input.session_id}.json`);
    const now = new Date().toISOString();

    if (status) {
      let state: SessionFile = {};
      try {
        state = JSON.parse(readFileSync(file, 'utf8')) as SessionFile;
      } catch {
        // A first event, or a file that is not readable: start again.
      }
      // A (re)start begins a new record, so the newest session of a workspace sorts last.
      if (event === 'SessionStart') state = { started_at: now };
      // claude's idle nudge, a minute after a fresh or just-cleared session starts, has nothing to wait on: no turn has been taken.
      const untouched = event === 'Notification' && input.notification_type === 'idle_prompt' && state.last_event === 'SessionStart';

      // A session resumed before its first SessionStart reached us still gets its fields filled in.
      state.session_id = input.session_id;
      state.started_at ||= now;
      state.cwd ||= input.cwd;
      state.transcript_path ||= input.transcript_path;
      state.cw_workspace_id ||= process.env.CW_WORKSPACE_ID || null;
      if (event === 'PostToolUse' && input.tool_name?.startsWith('mcp__claude-in-chrome__')) state.browser_at = now;
      state.status = status;
      if (status === 'needs_input') state.waiting = { type: str(input.notification_type) ?? '', message: oneLine(str(input.message) ?? '') };
      else delete state.waiting;
      state.status_since = now;
      state.last_event = event;

      if (!untouched) {
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
        renameSync(tmp, file);
      }
    }

    // Appends are atomic for a line this size, so concurrent events (a subagent's and claude's own) do not interleave.
    if (ACTIVITY_EVENTS.has(event))
      appendFileSync(join(dir, `${input.session_id}.events.jsonl`), `${JSON.stringify(activityLine(input, now))}\n`, { mode: 0o600 });
  }
} catch {
  // Never fail the session being observed.
}
process.exit(0);
