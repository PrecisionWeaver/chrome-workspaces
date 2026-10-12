import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOOK_SCRIPT } from '../src/hooks-config';
import { readSessionStatus } from '../src/session-status';

const ID = '169128c8-8b10-48e0-993f-a743c8fad9ef';

/** Runs the hook the way claude does: a real process, the event on stdin, the terminal's environment. */
function fire(data: string, event: unknown, env: Record<string, string> = { CW_WORKSPACE_ID: 'ws-0123abcd' }) {
  const stdin = typeof event === 'string' ? event : JSON.stringify(event);
  return spawnSync(process.execPath, [HOOK_SCRIPT], {
    input: stdin,
    env: { ...process.env, CW_DATA_DIR: data, CW_WORKSPACE_ID: '', ...env },
    encoding: 'utf8',
  });
}
const sessions = (data: string) => join(data, 'sessions');
const read = (data: string, id = ID) => JSON.parse(readFileSync(join(sessions(data), `${id}.json`), 'utf8'));

describe('hooks/session-state.ts', () => {
  it('records each event as a status, tied to the workspace from the environment', () => {
    const data = mkdtempSync(join(tmpdir(), 'cw-hook-'));
    fire(data, { hook_event_name: 'SessionStart', session_id: ID, cwd: '/repo', transcript_path: '/t.jsonl' });
    expect(read(data)).toMatchObject({
      session_id: ID,
      status: 'idle',
      cw_workspace_id: 'ws-0123abcd',
      cwd: '/repo',
      transcript_path: '/t.jsonl',
      last_event: 'SessionStart',
    });
    const states = ['UserPromptSubmit', 'Notification', 'PostToolUse', 'Stop', 'SessionEnd'].map((name) => {
      fire(data, { hook_event_name: name, session_id: ID });
      return read(data).status;
    });
    expect(states).toEqual(['working', 'needs_input', 'working', 'idle', 'ended']);
    expect(read(data)).toMatchObject({ cwd: '/repo', started_at: expect.any(String) });
  });

  it('is read back by the helper as the status of that workspace', () => {
    const data = mkdtempSync(join(tmpdir(), 'cw-hook-'));
    fire(data, { hook_event_name: 'Notification', session_id: ID, cwd: '/repo' });
    expect(readSessionStatus(sessions(data)).get('ws-0123abcd')).toMatchObject({ status: 'needs_input', claudeSessionId: ID, cwd: '/repo' });
  });

  it('fills in a session that never sent SessionStart, and a restart begins a fresh record', () => {
    const data = mkdtempSync(join(tmpdir(), 'cw-hook-'));
    fire(data, { hook_event_name: 'UserPromptSubmit', session_id: ID, cwd: '/repo' });
    const first = read(data).started_at;
    expect(first).toEqual(expect.any(String));
    fire(data, { hook_event_name: 'SessionStart', session_id: ID, cwd: '/other' });
    expect(read(data)).toMatchObject({ cwd: '/other', status: 'idle' });
    expect(read(data).started_at >= first).toBe(true);
  });

  it('notes a Claude in Chrome tool call, and no other tool', () => {
    const data = mkdtempSync(join(tmpdir(), 'cw-hook-'));
    fire(data, { hook_event_name: 'PostToolUse', session_id: ID, tool_name: 'Bash' });
    expect(read(data).browser_at).toBeUndefined();
    fire(data, { hook_event_name: 'PostToolUse', session_id: ID, tool_name: 'mcp__claude-in-chrome__navigate' });
    expect(read(data).browser_at).toEqual(expect.any(String));
  });

  it('exits 0 and writes nothing for bad input, an unknown event, or an id that is not a plain one', () => {
    const data = mkdtempSync(join(tmpdir(), 'cw-hook-'));
    const runs = [
      fire(data, 'not json'),
      fire(data, ''),
      fire(data, { hook_event_name: 'PreToolUse', session_id: ID }),
      fire(data, { hook_event_name: 'Stop', session_id: '../../evil' }),
      fire(data, { hook_event_name: 'Stop' }),
    ];
    expect(runs.map((run) => run.status)).toEqual([0, 0, 0, 0, 0]);
    expect(() => readdirSync(sessions(data))).toThrow();
  });

  it('leaves the workspace unset when claude was not started by the helper', () => {
    const data = mkdtempSync(join(tmpdir(), 'cw-hook-'));
    fire(data, { hook_event_name: 'Stop', session_id: ID }, {});
    expect(read(data).cw_workspace_id).toBeNull();
    expect(readSessionStatus(sessions(data)).size).toBe(0);
  });
});
