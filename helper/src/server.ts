import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL, type ClientMessage, type ServerMessage } from '../../shared/protocol';
import { isAuthorized, tokenFromProtocols, type AuthPolicy } from './auth';
import type { Session, SessionManager } from './session';

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ServerOptions {
  host: string;
  port: number;
  auth: AuthPolicy;
  sessions: SessionManager;
  onUnknownSession?: (id: string) => Session | undefined;
}

export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

export function startServer(options: ServerOptions): Promise<RunningServer> {
  const http = createServer((_req, res) => res.writeHead(404).end());
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has(PROTOCOL) ? PROTOCOL : false),
  });

  http.on('upgrade', (req, socket, head) => {
    const token = tokenFromProtocols(req.headers['sec-websocket-protocol']);
    if (!isAuthorized(options.auth, req.headers.origin, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleConnection(ws, req.url ?? '/', options));
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

  const session = options.sessions.get(id) ?? options.onUnknownSession?.(id);
  if (!session) {
    ws.close(4404, 'unknown session');
    return;
  }

  const send = (message: ServerMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  const detach = session.attach(
    (data) => send({ type: 'output', data }),
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
  });
  ws.on('close', detach);
}
