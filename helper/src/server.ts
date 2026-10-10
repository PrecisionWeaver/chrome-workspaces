import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_UPLOAD_BYTES, PROTOCOL, type ClientMessage, type ServerMessage } from '../../shared/protocol';
import { isAuthorized, tokenFromProtocols, type AuthPolicy } from './auth';
import type { ControlHub } from './control';
import type { Session, SessionManager } from './session';
import { saveUpload } from './uploads';

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ServerOptions {
  host: string;
  port: number;
  auth: AuthPolicy;
  sessions: SessionManager;
  onUnknownSession?: (id: string) => Session | undefined;
  control?: ControlHub;
  api?: (req: IncomingMessage, res: ServerResponse) => void;
  /** Where files dropped into a terminal are saved. Without it they are refused. */
  uploadDir?: string;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const http = createServer((req, res) => (options.api ? options.api(req, res) : res.writeHead(404).end()));
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
    // Room for a file at the upload limit, which travels as base64.
    maxPayload: Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 64 * 1024,
  });

  http.on('upgrade', (req, socket, head) => {
    const token = tokenFromProtocols(req.headers['sec-websocket-protocol']);
    if (!isAuthorized(options.auth, req.headers.origin, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const url = req.url ?? '/';
      if (options.control && new URL(url, 'http://localhost').pathname === '/control') options.control.add(ws);
      else handleConnection(ws, url, options);
    });
  });

  return new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, options.host, () => {
      const address = http.address();
      resolve({
        port: typeof address === 'object' && address ? address.port : options.port,
        close: () =>
          new Promise((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            http.close(() => done());
          }),
      });
    });
  });
}

function handleConnection(ws: WebSocket, url: string, options: ServerOptions): void {
  const { pathname, searchParams } = new URL(url, 'http://localhost');
  const id = searchParams.get('session');
  if (pathname !== '/attach' || !id || !SESSION_ID.test(id)) {
    ws.close(4400, 'bad request');
    return;
  }

  // A shell the user exited is replaced on the next attach, so reopening the panel starts fresh.
  if (options.sessions.get(id)?.exited && options.onUnknownSession) options.sessions.remove(id);
  const session = options.sessions.get(id) ?? options.onUnknownSession?.(id);
  if (!session) {
    ws.close(4404, 'unknown session');
    return;
  }

  const send = (message: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  const detach = session.attach(
    (data, replay) => send(replay ? { type: 'output', data, replay } : { type: 'output', data }),
    (code) => send({ type: 'exit', code }),
  );

  ws.on('message', (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (message.type === 'input') session.write(message.data);
    else if (message.type === 'resize') session.resize(message.cols, message.rows);
    else if (message.type === 'file' && typeof message.name === 'string' && typeof message.data === 'string') {
      if (!options.uploadDir) return send({ type: 'uploaded', name: message.name, path: null, error: 'uploads are not enabled' });
      try {
        send({ type: 'uploaded', name: message.name, path: saveUpload(options.uploadDir, id, message.name, message.data), error: null });
      } catch (error) {
        send({ type: 'uploaded', name: message.name, path: null, error: error instanceof Error ? error.message : String(error) });
      }
    }
  });
  ws.on('close', detach);
}
