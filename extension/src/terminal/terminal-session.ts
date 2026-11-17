import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol/protocol';
import { getHelper, openSocket } from '../app/helper-client';

export interface SessionTerminal {
  readonly term: Terminal;
  /** Opens the terminal in `parent` and switches to the GPU renderer where there is one. */
  open(parent: HTMLElement): void;
  /** Fits the terminal to its container and tells the session its new size. */
  refit(): void;
  /** Writes an `output` message from the session. */
  output(message: Extract<ServerMessage, { type: 'output' }>): void;
}

/**
 * The xterm every view uses (the panel, the tool view, a pop-out): fitted, with links opening in a tab, and typing
 * sent to `send` as input. A side panel cannot window.open, so links go to a tab of their own.
 */
export function createSessionTerminal(send: (message: ClientMessage) => void): SessionTerminal {
  // allowProposedApi: the Unicode 11 addon reads term.unicode, which xterm treats as proposed API and throws on otherwise.
  const term = new Terminal({
    fontFamily: 'Menlo, monospace',
    fontSize: 12,
    cursorBlink: true,
    allowProposedApi: true,
    theme: { background: '#1e1e1e' },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((_event, uri) => void chrome.tabs.create({ url: uri })));
  // Emoji and CJK take two cells; without Unicode 11 widths Claude's boxes and spinners drift out of line.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = '11';
  // Replayed scrollback can hold terminal queries (device attributes, say); xterm answers them through onData,
  // and the shell would read each answer as typed text. Whatever xterm emits while a replay is parsed is dropped.
  let replaying = false;
  term.onData((data) => {
    if (!replaying) send({ type: 'input', data });
  });
  return {
    term,
    open(parent) {
      term.open(parent);
      // The WebGL renderer must be loaded after open(). Without WebGL, or once its context is lost, xterm's DOM renderer stays.
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        /* no WebGL here */
      }
    },
    refit() {
      fit.fit();
      send({ type: 'resize', cols: term.cols, rows: term.rows });
    },
    output(message) {
      if (!message.replay) term.write(message.data);
      else {
        replaying = true;
        term.write(message.data, () => (replaying = false));
      }
    },
  };
}

/**
 * xterm sends the same \r for Enter and Shift+Enter; Claude reads ESC + \r as a newline, as iTerm can be set to send.
 * Returns whether xterm should go on to handle the key.
 */
export function shiftEnterNewline(event: KeyboardEvent, send: (message: ClientMessage) => void): boolean {
  if (event.key !== 'Enter' || !event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true;
  if (event.type === 'keydown') send({ type: 'input', data: '\x1b\r' });
  return false;
}

export interface SessionHandlers {
  /** Checked once the helper's address is known: false when the view has moved on to something else. */
  isCurrent?(): boolean;
  onOpen(): void;
  /** Every message but `output`, which is written to the terminal. */
  onMessage(message: Exclude<ServerMessage, { type: 'output' }>): void;
  /** The connection dropped (not closed by `close()`). */
  onDisconnect(): void;
  /** The helper's address could not be fetched. */
  onUnreachable(): void;
}

export interface SessionLink {
  /** Returns false when the session is not connected. */
  send(message: ClientMessage): boolean;
  close(): void;
}

/** Attaches to a helper session and feeds its output to `terminal`. The link is usable at once; it connects when the helper's address arrives. */
export function connectSession(session: string, terminal: SessionTerminal, handlers: SessionHandlers): SessionLink {
  let socket: WebSocket | null = null;
  let closed = false;
  getHelper().then(
    (helper) => {
      if (closed || handlers.isCurrent?.() === false) return;
      const ws = openSocket(helper, `/attach?session=${session}`);
      socket = ws;
      ws.onopen = () => handlers.onOpen();
      ws.onmessage = (event) => {
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type === 'output') terminal.output(message);
        else handlers.onMessage(message);
      };
      ws.onclose = () => {
        if (closed) return;
        socket = null;
        handlers.onDisconnect();
      };
    },
    () => {
      if (!closed) handlers.onUnreachable();
    },
  );
  return {
    send(message) {
      if (socket?.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    },
    close() {
      closed = true;
      socket?.close();
      socket = null;
    },
  };
}
