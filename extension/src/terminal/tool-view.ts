import type { ITheme } from '@xterm/xterm';
import { MONITOR_SESSION, SHELL_SESSION, workspaceShellSession } from '../../../shared/protocol/protocol';
import { $, isShortcut, wireBack } from '../ui/dom';
import { connectSession, createSessionTerminal, type SessionLink } from './terminal-session';

/** The terminals that belong to no workspace: each is a helper session of its own. */
const TOOLS = {
  monitor: { session: MONITOR_SESSION, title: 'System monitor' },
  shell: { session: SHELL_SESSION, title: 'Terminal' },
} as const;

export type Tool = keyof typeof TOOLS;

// How long a dropped connection waits before trying again; the same as the pop-out's.
const RETRY_MS = 2000;

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

  const terminal = createSessionTerminal((message) => link?.send(message));
  const { term } = terminal;
  // ⌘K / Ctrl+K is the palette's, even here: the key only declines xterm and reaches the panel's own handler, so the
  // shell does not also get it (it would delete to the end of the line).
  term.attachCustomKeyEventHandler((event) => !isShortcut(event, 'k'));
  let opened = false;
  let current: Target | null = null;
  let link: SessionLink | null = null;

  function resize(): void {
    if (current) terminal.refit();
  }
  new ResizeObserver(resize).observe(holder);

  function detach(): void {
    const old = link;
    link = null;
    old?.close();
  }

  /** Tries a dropped connection again, unless the view has moved on to another target. */
  function retry(target: Target, notice: string): void {
    link = null;
    if (current !== target) return;
    term.write(`\r\n\x1b[33m[${notice}]\x1b[0m\r\n`);
    setTimeout(() => {
      if (current === target && link === null) connect(target, true);
    }, RETRY_MS);
  }

  function connect(target: Target, reconnecting = false): void {
    link = connectSession(target.session, terminal, {
      isCurrent: () => current === target,
      onOpen() {
        // The helper replays the session's scrollback on attach, so what is on screen starts over.
        if (reconnecting) term.reset();
        resize();
        term.focus();
      },
      // The program quit (q in btop) or the shell exited, so go back to the workspace.
      onMessage(message) {
        if (message.type === 'exit') close();
      },
      onDisconnect: () => retry(target, 'disconnected from helper — reconnecting'),
      onUnreachable: () => retry(target, 'could not reach the helper — retrying'),
    });
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
    terminal.refit();
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
  };
}
