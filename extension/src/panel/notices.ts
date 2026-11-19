import { errorMessage } from '../../../shared/protocol/errors';
import { getHelper, isHostMissing, startHelper } from '../app/helper-client';
import { $, el } from '../ui/dom';

const MESSAGE_MS = 10_000;

export const INSTALL_COMMAND =
  'git clone https://github.com/PrecisionWeaver/chrome-workspaces.git && cd chrome-workspaces && npm install && npm run install-app';

/** The notice bar above the terminal: a plain message, or what to do about a helper that is not running. */
export interface Notices {
  /** Shows a message, or clears the bar with null. */
  show(text: string | null): void;
  showOffline(): void;
  showInstall(): void;
}

export function createNotices(): Notices {
  const noticeEl = $<HTMLDivElement>('notice');

  let clearTimer: ReturnType<typeof setTimeout> | undefined;

  function show(text: string | null): void {
    clearTimeout(clearTimer);
    noticeEl.hidden = text === null;
    noticeEl.textContent = text ?? '';
    // A message about something that failed (a workspace that was not made, a file not added) is not about the helper's state, which clears the
    // bar itself, so it goes after a while rather than staying until the connection next changes.
    if (text !== null) clearTimer = setTimeout(() => show(null), MESSAGE_MS);
  }

  // Chrome finds no native host until install-app has registered it, so there is nothing for Start helper to start.
  function showInstall(): void {
    const copy = el('button', 'Copy command', 'notice-action');
    copy.type = 'button';
    copy.onclick = () => {
      void navigator.clipboard.writeText(INSTALL_COMMAND);
      copy.textContent = 'Copied';
    };
    clearTimeout(clearTimer);
    noticeEl.hidden = false;
    noticeEl.replaceChildren(
      el(
        'span',
        'The helper is not installed. It comes from the repo, not the extension: clone it, run npm install and npm run install-app in it, then restart Chrome.',
      ),
      copy,
    );
  }

  function showOffline(): void {
    const start = el('button', 'Start helper', 'notice-action');
    start.type = 'button';
    const message = el('span', 'Helper not running.');
    start.onclick = () => {
      start.disabled = true;
      message.textContent = 'Starting the helper…';
      // On success the control connection's backoff reconnects and clears this notice.
      startHelper().catch((error) => {
        if (isHostMissing(error)) return showInstall();
        message.textContent = `Could not start the helper: ${errorMessage(error)}. Try npm run agent:start.`;
        start.disabled = false;
      });
    };
    clearTimeout(clearTimer);
    noticeEl.hidden = false;
    noticeEl.replaceChildren(message, start);
    // A helper that was never installed is not "not running"; say so up front.
    getHelper().catch((error) => {
      if (isHostMissing(error) && noticeEl.contains(message)) showInstall();
    });
  }

  return { show, showOffline, showInstall };
}
