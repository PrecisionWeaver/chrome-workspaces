import {
  NATIVE_HOST_NAME,
  PROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  type ControlToClient,
  type ControlToHelper,
  type NativeHostReply,
} from '../../shared/protocol';

export interface HelperAddress {
  token: string;
  port: number;
}

export async function getHelper(): Promise<HelperAddress> {
  const reply = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: 'hello' })) as NativeHostReply;
  if (!reply.ok) throw new Error(reply.error);
  return { token: reply.token, port: reply.port };
}

export function openSocket({ token, port }: HelperAddress, path: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}${path}`, [PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`]);
}

export interface ControlConnection {
  /** Returns false when the helper is not connected. */
  send(message: ControlToHelper): boolean;
  readonly connected: boolean;
}

/**
 * Holds a `/control` connection open, reconnecting with backoff. The periodic ping also keeps
 * an MV3 service worker alive while connected, so it can act on requests from local tools.
 */
export function connectControl(onMessage: (message: ControlToClient) => void, onConnectedChange?: (connected: boolean) => void): ControlConnection {
  let socket: WebSocket | null = null;
  let delay = 1000;
  let ping: ReturnType<typeof setInterval> | undefined;

  const setConnected = (value: boolean) => onConnectedChange?.(value);

  async function connect(): Promise<void> {
    try {
      const ws = openSocket(await getHelper(), '/control');
      socket = ws;
      ws.onopen = () => {
        delay = 1000;
        ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), 20_000);
        setConnected(true);
      };
      ws.onmessage = (event) => onMessage(JSON.parse(event.data as string) as ControlToClient);
      ws.onclose = () => {
        clearInterval(ping);
        if (socket === ws) socket = null;
        setConnected(false);
        retry();
      };
    } catch {
      setConnected(false);
      retry();
    }
  }

  function retry(): void {
    setTimeout(() => void connect(), delay);
    delay = Math.min(delay * 2, 30_000);
  }

  void connect();

  return {
    send(message) {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    get connected() {
      return socket?.readyState === WebSocket.OPEN;
    },
  };
}
