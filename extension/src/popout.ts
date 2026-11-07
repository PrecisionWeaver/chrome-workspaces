import { popoutWorkspaceId } from '../../shared/popout';
import type { ClientMessage, ControlToClient } from '../../shared/protocol';
import { followAppearance } from './appearance';
import { $ } from './dom';
import { connectControl } from './helper-client';
import { connectSession, createSessionTerminal, shiftEnterNewline, type SessionLink } from './terminal-session';
import { terminalTheme } from './terminal-theme';

/** How long to wait before attaching again after the helper connection drops. */
const RETRY_MS = 2000;

const id = popoutWorkspaceId(location.href);
const terminalEl = $<HTMLDivElement>('terminal');
const nameEl = $<HTMLSpanElement>('name');
const statusEl = $<HTMLSpanElement>('status');

let link: SessionLink | null = null;
let closed = false;
const send = (message: ClientMessage) => link?.send(message);

const terminal = createSessionTerminal(send);
const { term } = terminal;
term.open(terminalEl);
term.attachCustomKeyEventHandler((event) => shiftEnterNewline(event, send));
followAppearance((theme) => {
  term.options.theme = terminalTheme(theme);
});

new ResizeObserver(() => terminal.refit()).observe(terminalEl);
// The side panel can show this session at another size; the last view in use sets the terminal's.
window.addEventListener('focus', () => terminal.refit());

/** The workspace is gone (archived, removed, or its shell exited): say so, then close the window. */
function finish(reason: string): void {
  if (closed) return;
  closed = true;
  link?.close();
  link = null;
  term.write(`\r\n\x1b[33m[${reason}]\x1b[0m\r\n`);
  setTimeout(() => window.close(), 1500);
}

function attach(workspace: string): void {
  const retry = (notice: string) => {
    link = null;
    term.write(`\r\n\x1b[33m[${notice}]\x1b[0m\r\n`);
    setTimeout(() => attach(workspace), RETRY_MS);
  };
  link = connectSession(workspace, terminal, {
    onOpen() {
      term.reset();
      terminal.refit();
      term.focus();
    },
    onMessage: (message) => message.type === 'exit' && finish('Workspace closed'),
    onDisconnect: () => retry('disconnected from helper — reconnecting'),
    onUnreachable: () => retry('could not reach the helper — retrying'),
  });
}

if (id === null) {
  nameEl.textContent = 'No workspace';
  term.write('\x1b[33mThis window was not opened for a workspace.\x1b[0m\r\n');
} else {
  const workspace = id;
  attach(workspace);
  connectControl((message: ControlToClient) => {
    if (message.type !== 'state') return;
    const ws = message.workspaces.find((candidate) => candidate.id === workspace);
    if (!ws) return finish('Workspace closed');
    nameEl.textContent = ws.name;
    document.title = ws.name;
    const status = message.statuses[workspace];
    if (status) statusEl.dataset.status = status;
    else delete statusEl.dataset.status;
  });
}
