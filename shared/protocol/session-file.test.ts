import { describe, expect, it } from 'vitest';
import { notificationWaits, STATUS_BY_EVENT } from './session-file';

describe('notificationWaits', () => {
  it('takes an untyped or unknown notification as waiting on the user', () => {
    expect(notificationWaits(undefined)).toBe(true);
    expect(notificationWaits('')).toBe(true);
    expect(notificationWaits('permission_prompt')).toBe(true);
    expect(notificationWaits('idle_prompt')).toBe(true);
  });

  it('knows the notifications that only report something', () => {
    for (const type of ['auth_success', 'elicitation_complete', 'elicitation_response', 'agent_completed', 'plugin_notification']) {
      expect(notificationWaits(type)).toBe(false);
    }
    for (const type of ['quota_auto_resume_fired', 'quota_auto_resume_stale', 'quota_auto_resume_disabled']) {
      expect(notificationWaits(type)).toBe(false);
    }
  });
});

describe('STATUS_BY_EVENT', () => {
  it('moves a session through idle, working, needs_input and ended', () => {
    expect(STATUS_BY_EVENT.SessionStart).toBe('idle');
    expect(STATUS_BY_EVENT.UserPromptSubmit).toBe('working');
    expect(STATUS_BY_EVENT.Notification).toBe('needs_input');
    expect(STATUS_BY_EVENT.Stop).toBe('idle');
    expect(STATUS_BY_EVENT.SessionEnd).toBe('ended');
  });

  it('counts a tool starting as working, so an answered permission prompt clears needs_input', () => {
    expect(STATUS_BY_EVENT.PreToolUse).toBe('working');
    expect(STATUS_BY_EVENT.PostToolUse).toBe('working');
    expect(STATUS_BY_EVENT.PostToolUseFailure).toBe('working');
  });
});
