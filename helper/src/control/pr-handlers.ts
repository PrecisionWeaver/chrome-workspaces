import type { WebSocket } from 'ws';
import type { ControlToHelper } from '../../../shared/protocol/protocol';
import { parsePrDetails, parsePrThreads, parsePrUrl } from '../git/pr-details';
import type { HubContext } from './hub';

export type PrRequest = Extract<ControlToHelper, { type: 'prThreads' | 'prDetails' }>;

export function isPrRequest(message: ControlToHelper): message is PrRequest {
  return message.type === 'prThreads' || message.type === 'prDetails';
}

/** Answers what the New workspace view asks about a pull request: its review threads and its details. */
export function handlePr(hub: HubContext, message: PrRequest, ws: WebSocket): void {
  const { prThreads, prDetails } = hub.options;
  const { url } = message;
  if (message.type === 'prThreads') {
    const parts = parsePrUrl(url);
    hub.answer(
      ws,
      parts ? prThreads(parts).then(parsePrThreads) : Promise.reject(new Error('not a pull request URL')),
      ({ threads, total }) => ({ type: 'prThreads', url, threads, total, error: null }),
      (error) => ({ type: 'prThreads', url, threads: [], total: 0, error }),
    );
    return;
  }
  hub.answer(
    ws,
    prDetails(url).then(parsePrDetails),
    (details) => ({ type: 'prDetails', url, details, error: null }),
    (error) => ({ type: 'prDetails', url, details: null, error }),
  );
}
