import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import {
  NATIVE_HOST_NAME,
  PROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  type ClientMessage,
  type NativeHostReply,
  type ServerMessage,
} from '../../shared/protocol';

const statusEl = document.getElementById('status') as HTMLElement;
const terminalEl = document.getElementById('terminal') as HTMLElement;

const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 12, cursorBlink: true });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(terminalEl);
fit.fit();

let connection = 'connecting';
let lastShortcut = 'none';
let socket: WebSocket | null = null;

function renderStatus(): void {
  statusEl.textContent = `panel ${window.innerWidth}px · ${term.cols} cols · ${connection} · last shortcut: ${lastShortcut}`;
}

function sendToHelper(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

chrome.runtime.onMessage.addListener((message: { type?: string; command?: string }) => {
  if (message.type === 'command' && message.command) {
    lastShortcut = `${message.command} @ ${new Date().toLocaleTimeString()}`;
    renderStatus();
  }
});

term.onData((data) => sendToHelper({ type: 'input', data }));

new ResizeObserver(() => {
  fit.fit();
  sendToHelper({ type: 'resize', cols: term.cols, rows: term.rows });
  renderStatus();
}).observe(terminalEl);

async function connect(): Promise<void> {
  const reply = (await chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, { type: 'hello' })) as NativeHostReply;
  if (!reply.ok) throw new Error(reply.error);

  const { id: windowId } = await chrome.windows.getCurrent();
  const ws = new WebSocket(`ws://127.0.0.1:${reply.port}/attach?session=win-${windowId}`, [
    PROTOCOL,
    `${TOKEN_PROTOCOL_PREFIX}${reply.token}`,
  ]);
  socket = ws;

  ws.onopen = () => {
    connection = `attached win-${windowId}`;
    sendToHelper({ type: 'resize', cols: term.cols, rows: term.rows });
    renderStatus();
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data as string) as ServerMessage;
    if (message.type === 'output') {
      term.write(message.data);
    } else {
      connection = `session exited (${message.code})`;
      renderStatus();
    }
  };
  ws.onclose = (event) => {
    connection = `disconnected (${event.code})`;
    renderStatus();
  };
}

renderStatus();
connect().catch((error: unknown) => {
  connection = `error: ${error instanceof Error ? error.message : String(error)}`;
  renderStatus();
});
