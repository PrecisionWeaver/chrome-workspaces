import { attentionEvents, describeWaiting, needsInputCount } from '../../../shared/workspaces/attention';
import type { ControlToClient, WaitingOn, Workspace, WorkspaceStatus } from '../../../shared/protocol/protocol';

export interface AttentionDeps {
  workspaces(): readonly Workspace[];
  /** Brings a workspace's window or group forward; called when its notification is clicked. */
  open(workspace: Workspace): void;
}

/** The toolbar badge, and the optional notifications for a workspace that starts waiting or finishes. */
export function installAttention({ workspaces, open }: AttentionDeps) {
  let previous: Record<string, WorkspaceStatus> | null = null;
  const find = (id: string) => workspaces().find((ws) => ws.id === id);

  async function notificationsOn(): Promise<boolean> {
    const { prefs } = (await chrome.storage.local.get('prefs')) as { prefs?: { notify?: boolean } };
    return prefs?.notify === true;
  }

  chrome.notifications.onClicked.addListener((notificationId) => {
    const workspace = find(notificationId.replace(/^ws-/, ''));
    chrome.notifications.clear(notificationId);
    if (workspace) open(workspace);
  });

  return {
    /** Shows how many workspaces wait on the user, and notifies when one starts waiting or finishes. */
    async announce(statuses: Record<string, WorkspaceStatus>, wantedBy: Record<string, WaitingOn>): Promise<void> {
      const waiting = needsInputCount(
        statuses,
        workspaces().map((ws) => ws.id),
      );
      await chrome.action.setBadgeText({ text: waiting ? String(waiting) : '' });
      await chrome.action.setBadgeBackgroundColor({ color: '#f26d6d' });
      // The first state only sets the baseline, so reopening Chrome with sessions already waiting is quiet.
      const events = previous ? attentionEvents(previous, statuses) : [];
      previous = statuses;
      if (events.length === 0 || !(await notificationsOn())) return;
      for (const event of events) {
        const workspace = find(event.id);
        if (!workspace) continue;
        const wanted = describeWaiting(workspace.name, wantedBy[event.id]);
        chrome.notifications.create(`ws-${event.id}`, {
          type: 'basic',
          iconUrl: 'icons/icon-128.png',
          title: event.kind === 'needs_input' ? wanted.title : `${workspace.name} finished`,
          message: event.kind === 'needs_input' ? wanted.message : 'Claude is idle again.',
          priority: 1,
        });
      }
    },

    /** Says whether text sent to a workspace's terminal arrived. */
    notifySent(message: Extract<ControlToClient, { type: 'sent' }>): void {
      const name = find(message.id)?.name ?? 'workspace';
      chrome.notifications.create(`sent-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: message.ok ? `Sent to ${name}` : `Could not send to ${name}`,
        message: message.message,
      });
    },
  };
}
