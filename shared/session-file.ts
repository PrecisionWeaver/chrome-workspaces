export type HookStatus = 'idle' | 'working' | 'needs_input' | 'ended';

/** The events the hook listens to, and the status each leaves a session in. */
export const STATUS_BY_EVENT: Record<string, HookStatus> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  Notification: 'needs_input',
  PostToolUse: 'working',
  Stop: 'idle',
  SessionEnd: 'ended',
};

/** One claude session, as hooks/session-state.ts writes it to `sessions/<id>.json`. */
export interface SessionFile {
  session_id?: string;
  /** Set by the helper in the terminal's environment, so a session can be matched to its workspace. */
  cw_workspace_id?: string | null;
  status?: HookStatus;
  status_since?: string;
  last_event?: string;
  started_at?: string;
  /** Last Claude in Chrome tool call; used to find which session opened a tab group. */
  browser_at?: string;
  /** The directory claude started in. */
  cwd?: string;
  transcript_path?: string;
}
