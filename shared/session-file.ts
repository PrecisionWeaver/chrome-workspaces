import type { WaitingOn } from './protocol';

export type HookStatus = 'idle' | 'working' | 'needs_input' | 'ended';

/** The events the hook listens to, and the status each leaves a session in. */
export const STATUS_BY_EVENT: Record<string, HookStatus> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  Notification: 'needs_input',
  // A tool starting means any permission prompt was answered, so a session left at needs_input is working again.
  PreToolUse: 'working',
  PostToolUse: 'working',
  PostToolUseFailure: 'working',
  Stop: 'idle',
  SessionEnd: 'ended',
};

/** Notifications that report something (a sign-in, a subagent done, a plugin's news) rather than wait on the user. */
const PASSIVE_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'auth_success',
  'elicitation_complete',
  'elicitation_response',
  'agent_completed',
  'quota_auto_resume_fired',
  'quota_auto_resume_stale',
  'quota_auto_resume_disabled',
  'plugin_notification',
]);

/** Whether a Notification of this type leaves claude waiting on the user. An unknown type is taken to, as every one did before types were told apart. */
export const notificationWaits = (type: string | undefined): boolean => !type || !PASSIVE_NOTIFICATIONS.has(type);

/** One claude session, as hooks/session-state.ts writes it to `sessions/<id>.json`. */
export interface SessionFile {
  session_id?: string;
  /** Set by the helper in the terminal's environment, so a session can be matched to its workspace. */
  cw_workspace_id?: string | null;
  status?: HookStatus;
  /** Set while `status` is `needs_input`: what the Notification said claude waits on. */
  waiting?: WaitingOn;
  status_since?: string;
  last_event?: string;
  started_at?: string;
  /** Last Claude in Chrome tool call; used to find which session opened a tab group. */
  browser_at?: string;
  /** The directory claude started in. */
  cwd?: string;
  transcript_path?: string;
}
