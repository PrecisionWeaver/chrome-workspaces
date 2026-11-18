import type { WebSocket } from 'ws';
import type { ControlToHelper } from '../../../shared/protocol/protocol';
import { errorMessage } from '../../../shared/protocol/errors';
import type { HubContext } from './hub';

export type AdminRequest = Extract<
  ControlToHelper,
  { type: 'system' | 'admin' | 'systemLog' | 'timeline' | 'exportData' | 'checkUpdates' | 'getConfigEdit' | 'saveConfigEdit' }
>;

const ADMIN_REQUESTS: ReadonlySet<string> = new Set([
  'system',
  'admin',
  'systemLog',
  'timeline',
  'exportData',
  'checkUpdates',
  'getConfigEdit',
  'saveConfigEdit',
]);

export function isAdminRequest(message: ControlToHelper): message is AdminRequest {
  return ADMIN_REQUESTS.has(message.type);
}

/** Answers what Settings asks of the helper: the snapshot, its actions, the log, a session's timeline, the export, the update check and the config editor. */
export function handleAdmin(hub: HubContext, message: AdminRequest, ws: WebSocket): void {
  const { admin, reviews, store, configEdit } = hub.options;
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
    case 'getConfigEdit':
      try {
        hub.sendTo(ws, { type: 'configEdit', edit: configEdit.read(), error: null });
      } catch (error) {
        hub.sendTo(ws, { type: 'configEdit', edit: null, error: errorMessage(error) });
      }
      break;
    case 'saveConfigEdit': {
      const result = configEdit.save(message.values, message.prompts);
      let edit = null;
      try {
        edit = configEdit.read();
      } catch {
        // The reply still says whether the save worked; the editor keeps what it has.
      }
      hub.sendTo(ws, { type: 'configSaved', ok: result.ok, message: result.message, edit });
      break;
    }
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
