import { errorMessage } from '../../../shared/protocol/errors';
import { getHelper, isHostMissing, startHelper } from '../app/helper-client';
import { $, el } from '../ui/dom';

export const INSTALL_COMMAND = 'npm run install-app';

/** The notice bar above the terminal: a plain message, or what to do about a helper that is not running. */
export interface Notices {
  /** Shows a message, or clears the bar with null. */
  show(text: string | null): void;
  showOffline(): void;
  showInstall(): void;
}

export function createNotices(): Notices {
  const noticeEl = $<HTMLDivElement>('notice');

  function show(text: string | null): void {
    noticeEl.hidden = text === null;
    noticeEl.textContent = text ?? '';
  }

  // Chrome finds no native host until install-app has registered it, so there is nothing for Start helper to start.
  function showInstall(): void {
    const copy = el('button', 'Copy command', 'notice-action');
    copy.type = 'button';
    copy.onclick = () => {
      void navigator.clipboard.writeText(INSTALL_COMMAND);
      copy.textContent = 'Copied';
    };
    noticeEl.hidden = false;
    noticeEl.replaceChildren(el('span', `The helper is not installed. In the chrome-workspaces folder, run ${INSTALL_COMMAND}, then restart Chrome.`), copy);
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
    noticeEl.hidden = false;
    noticeEl.replaceChildren(message, start);
    // A helper that was never installed is not "not running"; say so up front.
    getHelper().catch((error) => {
      if (isHostMissing(error) && noticeEl.contains(message)) showInstall();
    });
  }

  return { show, showOffline, showInstall };
}
