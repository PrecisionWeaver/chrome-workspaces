import type { WebSocket } from 'ws';
import type { ControlToHelper } from '../../../shared/protocol/protocol';
import type { HubContext } from './hub';

export type AdminRequest = Extract<ControlToHelper, { type: 'system' | 'admin' | 'systemLog' | 'timeline' | 'exportData' | 'checkUpdates' }>;

const ADMIN_REQUESTS: ReadonlySet<string> = new Set(['system', 'admin', 'systemLog', 'timeline', 'exportData', 'checkUpdates']);

export function isAdminRequest(message: ControlToHelper): message is AdminRequest {
  return ADMIN_REQUESTS.has(message.type);
}

/** Answers what Settings asks of the helper: the snapshot, its actions, the log, a session's timeline, the export and the update check. */
export function handleAdmin(hub: HubContext, message: AdminRequest, ws: WebSocket): void {
  const { admin, reviews, store } = hub.options;
  switch (message.type) {
    case 'system':
      hub.answer(
        ws,
        admin.snapshot({ reviews: reviews.state(), clients: hub.clientCount }),
        (snapshot) => ({ type: 'system', snapshot, error: null }),
        (error) => ({ type: 'system', snapshot: null, error }),
      );
      break;
    case 'admin': {
      const { request } = message;
      hub.answer(
        ws,
        admin.run(request),
        (result) => {
          for (const id of result.reset ?? []) hub.send({ type: 'sessionReset', id });
          return { type: 'adminResult', action: request.action, ok: result.ok, message: result.message };
        },
        (reason) => ({ type: 'adminResult', action: request.action, ok: false, message: reason }),
      );
      break;
    }
    case 'systemLog':
      hub.sendTo(ws, { type: 'systemLog', text: admin.log() });
      break;
    case 'timeline': {
      const events = store.get(message.id) ? admin.timeline(message.id) : null;
      hub.sendTo(ws, {
        type: 'timeline',
        id: message.id,
        events: events ?? [],
        error: events === null ? 'This workspace has no claude session yet.' : null,
      });
      break;
    }
    case 'exportData':
      hub.sendTo(ws, { type: 'exportData', json: admin.exportData() });
      break;
    case 'checkUpdates':
      hub.answer(
        ws,
        admin.checkUpdates(),
        (status) => ({ type: 'updates', status, error: null }),
        (error) => ({ type: 'updates', status: null, error }),
      );
      break;
  }
}
