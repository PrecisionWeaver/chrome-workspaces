import type { ClientMessage, Workspace } from '../../../shared/protocol/protocol';
import { connectSession, type SessionLink, type SessionTerminal } from '../terminal/terminal-session';

export interface SessionAttachmentOptions {
  terminal: SessionTerminal;
  /** The element the terminal is in; it is refitted only while showing. */
  terminalEl: HTMLElement;
  /** The window this panel is in, which closes when the shell exits. */
  windowId: () => number | undefined;
  showNotice: (text: string) => void;
}

/** The panel's terminal attached to one workspace's session at a time. */
export interface SessionAttachment {
  /** The workspace whose session the terminal is attached to, if any. */
  attachedId(): string | null;
  attach(workspace: Workspace): void;
  detach(): void;
  /** Sends to the attached session; false when there is none. */
  send(message: ClientMessage): boolean;
  /** Refits the terminal to its element, when it is showing. */
  fit(): void;
}

export function createSessionAttachment({ terminal, terminalEl, windowId, showNotice }: SessionAttachmentOptions): SessionAttachment {
  const { term } = terminal;
  let link: SessionLink | null = null;
  let attachedId: string | null = null;

  function fitTerminal(): void {
    if (!terminalEl.hidden) terminal.refit();
  }

  function detach(): void {
    const old = link;
    link = null;
    attachedId = null;
    old?.close();
  }

  function attach(workspace: Workspace): void {
    if (attachedId === workspace.id && link) return;
    detach();
    term.reset();
    attachedId = workspace.id;

    link = connectSession(workspace.id, terminal, {
      onOpen() {
        fitTerminal();
        term.focus();
      },
      onMessage(message) {
        // The saved path is pasted, so a program that takes pastes (claude) treats it as an attachment.
        if (message.type === 'uploaded') {
          if (message.path) term.paste(`${message.path} `);
          else showNotice(`Could not add ${message.name}: ${message.error ?? 'unknown error'}`);
        }
        // The shell is gone; close the panel. Reopening it starts a fresh session.
        else if (windowId() !== undefined) void chrome.sidePanel.close({ windowId: windowId()! });
        else window.close();
      },
      onDisconnect() {
        link = null;
        term.write('\r\n\x1b[33m[disconnected from helper — reconnects when it is back]\x1b[0m\r\n');
      },
      // The control connection's notice explains the outage; the next state retries the attach.
      onUnreachable() {
        link = null;
        attachedId = null;
      },
    });
  }

  return {
    attachedId: () => attachedId,
    attach,
    detach,
    send: (message) => link?.send(message) ?? false,
    fit: fitTerminal,
  };
}
