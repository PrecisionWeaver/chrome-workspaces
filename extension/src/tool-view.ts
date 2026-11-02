import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal, type ITheme } from '@xterm/xterm';
import { MONITOR_SESSION, SHELL_SESSION, type ClientMessage, type ServerMessage, workspaceShellSession } from '../../shared/protocol';
import { $, wireBack } from './dom';
import { getHelper, openSocket } from './helper-client';

/** The terminals that belong to no workspace: each is a helper session of its own. */
export const TOOLS = {
  monitor: { session: MONITOR_SESSION, title: 'System monitor' },
  shell: { session: SHELL_SESSION, title: 'Terminal' },
} as const;

export type Tool = keyof typeof TOOLS;

/** What the view is attached to: a tool, or a workspace's own shell. */
interface Target {
  key: string;
  session: string;
  title: string;
}

export interface ToolViewOptions {
  /** Called after the view opens or closes, so the panel can hide what it covers. */
  onToggle(): void;
}

export interface ToolView {
  readonly isOpen: boolean;
  /** The tool showing (its name, or a workspace shell's session id), or null. */
  readonly current: string | null;
  /** Opens the tool, or switches to it if the other one is showing. */
  show(tool: Tool): void;
  /** A login shell in the workspace's directory, its own session, kept running like the plain terminal. */
  showShell(workspace: { id: string; name: string }): void;
  close(): void;
  setTheme(theme: ITheme): void;
  setFontSize(size: number): void;
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
  term.loadAddon(new WebLinksAddon((_event, uri) => void chrome.tabs.create({ url: uri })));
  let opened = false;
  let current: Target | null = null;
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

  function connect(target: Target): void {
    getHelper().then(
      (helper) => {
        if (current !== target) return;
        const ws = openSocket(helper, `/attach?session=${target.session}`);
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
          if (current === target) term.write('\r\n\x1b[33m[disconnected from helper]\x1b[0m\r\n');
        };
      },
      () => {
        if (current === target) term.write('\r\n\x1b[33m[could not reach the helper]\x1b[0m\r\n');
      },
    );
  }

  function show(tool: Tool): void {
    showTarget({ key: tool, ...TOOLS[tool] });
  }

  function showTarget(target: Target): void {
    if (current?.key === target.key) return;
    const wasOpen = current !== null;
    detach();
    current = target;
    title.textContent = target.title;
    section.hidden = false;
    if (!wasOpen) onToggle();
    // xterm measures its container, so it is opened once the section is visible.
    if (!opened) {
      term.open(holder);
      opened = true;
    }
    term.reset();
    fit.fit();
    connect(target);
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
      return current?.key ?? null;
    },
    show,
    showShell: (workspace) =>
      showTarget({ key: workspaceShellSession(workspace.id), session: workspaceShellSession(workspace.id), title: `Terminal · ${workspace.name}` }),
    close,
    setTheme(theme) {
      term.options.theme = theme;
    },
    setFontSize(size) {
      if (term.options.fontSize === size) return;
      term.options.fontSize = size;
      resize();
    },
  };
}
