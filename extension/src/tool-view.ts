import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ITheme } from '@xterm/xterm';
import { MONITOR_SESSION, SHELL_SESSION, type ClientMessage, type ServerMessage } from '../../shared/protocol';
import { $, wireBack } from './dom';
import { getHelper, openSocket } from './helper-client';

/** The terminals that belong to no workspace: each is a helper session of its own. */
export const TOOLS = {
  monitor: { session: MONITOR_SESSION, title: 'System monitor' },
  shell: { session: SHELL_SESSION, title: 'Terminal' },
} as const;

export type Tool = keyof typeof TOOLS;

export interface ToolViewOptions {
  /** Called after the view opens or closes, so the panel can hide what it covers. */
  onToggle(): void;
}

export interface ToolView {
  readonly isOpen: boolean;
  /** The tool showing, or null. */
  readonly current: Tool | null;
  /** Opens the tool, or switches to it if the other one is showing. */
  show(tool: Tool): void;
  close(): void;
  setTheme(theme: ITheme): void;
}

/**
 * The system monitor (btop) and a plain shell, one at a time, each a terminal attached to its own helper
 * session. The helper stops the monitor when nobody is looking; the shell keeps running, so a dev server
 * started in it survives closing the view, and reopening it reattaches with the scrollback.
 */
export function createToolView({ onToggle }: ToolViewOptions): ToolView {
  const section = $<HTMLElement>('tool');
  const holder = $<HTMLDivElement>('tool-terminal');
  const title = $<HTMLSpanElement>('tool-title');
  wireBack('tool-close', close);

  const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 12, cursorBlink: true, theme: { background: '#1e1e1e' } });
  const fit = new FitAddon();
  term.loadAddon(fit);
  let opened = false;
  let current: Tool | null = null;
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
    if (!current) return;
    fit.fit();
    send({ type: 'resize', cols: term.cols, rows: term.rows });
  }
  new ResizeObserver(resize).observe(holder);

  function detach(): void {
    const old = socket;
    socket = null;
    old?.close();
  }

  function connect(tool: Tool): void {
    getHelper().then(
      (helper) => {
        if (current !== tool) return;
        const ws = openSocket(helper, `/attach?session=${TOOLS[tool].session}`);
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
          // The program quit (q in btop) or the shell exited, so go back to the workspace.
          else if (message.type === 'exit') close();
        };
        ws.onclose = () => {
          if (socket !== ws) return;
          socket = null;
          if (current === tool) term.write('\r\n\x1b[33m[disconnected from helper]\x1b[0m\r\n');
        };
      },
      () => {
        if (current === tool) term.write('\r\n\x1b[33m[could not reach the helper]\x1b[0m\r\n');
      },
    );
  }

  function show(tool: Tool): void {
    if (current === tool) return;
    const wasOpen = current !== null;
    detach();
    current = tool;
    title.textContent = TOOLS[tool].title;
    section.hidden = false;
    if (!wasOpen) onToggle();
    // xterm measures its container, so it is opened once the section is visible.
    if (!opened) {
      term.open(holder);
      opened = true;
    }
    term.reset();
    fit.fit();
    connect(tool);
  }

  function close(): void {
    if (!current) return;
    current = null;
    detach();
    section.hidden = true;
    onToggle();
  }

  return {
    get isOpen() {
      return current !== null;
    },
    get current() {
      return current;
    },
    show,
    close,
    setTheme(theme) {
      term.options.theme = theme;
    },
  };
}
