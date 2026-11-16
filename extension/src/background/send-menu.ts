import type { ControlToHelper, Workspace } from '../../../shared/protocol/protocol';

const SEND_PARENT = 'send-to-workspace';
const MAX_MENU_WORKSPACES = 20;

export interface SendMenuDeps {
  workspaces(): readonly Workspace[];
  send(message: ControlToHelper): boolean;
}

/**
 * The right-click "Send to workspace" menu: selected text, a link or a page goes to a workspace's terminal. `rebuild`
 * brings the menu in line with the workspaces and is cheap to call on every state, since it only works when they change.
 */
export function installSendMenu({ workspaces, send }: SendMenuDeps): { rebuild(): Promise<void> } {
  let key = '';
  let build: Promise<void> = Promise.resolve();

  function rebuild(): Promise<void> {
    const listed = workspaces().slice(0, MAX_MENU_WORKSPACES);
    const next = listed.map((ws) => `${ws.id}:${ws.name}`).join('|');
    if (next === key) return build;
    key = next;
    // One build at a time: removeAll and create are asynchronous and would interleave.
    build = build.then(async () => {
      await chrome.contextMenus.removeAll();
      if (listed.length === 0) return;
      const contexts: ['selection', 'link', 'page'] = ['selection', 'link', 'page'];
      chrome.contextMenus.create({ id: SEND_PARENT, title: 'Send to workspace', contexts });
      for (const ws of listed) chrome.contextMenus.create({ id: `send:${ws.id}`, parentId: SEND_PARENT, title: ws.name, contexts });
    });
    return build;
  }

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    const id = String(info.menuItemId);
    if (!id.startsWith('send:')) return;
    // What was right-clicked: selected text, else the link, else the page.
    const text = info.selectionText?.trim() || info.linkUrl || [tab?.title, info.pageUrl ?? tab?.url].filter(Boolean).join('\n');
    if (text) send({ type: 'sendText', id: id.slice('send:'.length), text });
  });

  return { rebuild };
}
