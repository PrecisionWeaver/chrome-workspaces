import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import { MONITOR_SESSION, type ClientMessage, type ServerMessage } from '../../shared/protocol';
import { getHelper, openSocket } from './helper-client';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface MonitorViewOptions {
  /** Called after the view opens or closes, so the panel can hide what it covers. */
  onToggle(): void;
}

export interface MonitorView {
  readonly isOpen: boolean;
  show(): void;
  close(): void;
  setTheme(theme: ITheme): void;
}

/**
 * The system monitor (btop): a terminal of its own, attached to the helper's monitor session. The session
 * lives only while this view is open, so closing the view stops it.
 */
export function createMonitorView({ onToggle }: MonitorViewOptions): MonitorView {
  const section = $<HTMLElement>('monitor');
  const holder = $<HTMLDivElement>('monitor-terminal');
  $<HTMLButtonElement>('monitor-close').addEventListener('click', close);

  const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 12, cursorBlink: false, theme: { background: '#1e1e1e' } });
  const fit = new FitAddon();
  term.loadAddon(fit);
  let opened = false;
  let isOpen = false;
  let socket: WebSocket | null = null;
  // Replayed output holds terminal queries that were already answered; xterm's replies to them are dropped.
  let replaying = false;

  const send = (message: ClientMessage) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };
  term.onData((data) => {
    if (!replaying) send({ type: 'input', data });
  });

  function resize(): void {
    if (!isOpen) return;
    fit.fit();
    send({ type: 'resize', cols: term.cols, rows: term.rows });
  }
  new ResizeObserver(resize).observe(holder);

  function connect(): void {
    getHelper().then(
      (helper) => {
        if (!isOpen) return;
        const ws = openSocket(helper, `/attach?session=${MONITOR_SESSION}`);
        socket = ws;
        ws.onopen = () => {
          resize();
          term.focus();
        };
        ws.onmessage = (event) => {
          const message = JSON.parse(event.data as string) as ServerMessage;
          if (message.type === 'output') {
            if (!message.replay) term.write(message.data);
            else {
              replaying = true;
              term.write(message.data, () => (replaying = false));
            }
          }
          // Quitting the program (q) ends the session, so go back to the workspace.
          else if (message.type === 'exit') close();
        };
        ws.onclose = () => {
          if (socket !== ws) return;
          socket = null;
          if (isOpen) term.write('\r\n\x1b[33m[disconnected from helper]\x1b[0m\r\n');
        };
      },
      () => {
        if (isOpen) term.write('\r\n\x1b[33m[could not reach the helper]\x1b[0m\r\n');
      },
    );
  }

  function show(): void {
    if (isOpen) return;
    isOpen = true;
    section.hidden = false;
    onToggle();
    // xterm measures its container, so it is opened once the section is visible.
    if (!opened) {
      term.open(holder);
      opened = true;
    }
    term.reset();
    fit.fit();
    connect();
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    const old = socket;
    socket = null;
    old?.close();
    section.hidden = true;
    onToggle();
  }

  return {
    get isOpen() {
      return isOpen;
    },
    show,
    close,
    setTheme(theme) {
      term.options.theme = theme;
    },
  };
}
