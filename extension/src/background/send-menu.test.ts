import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlToHelper, Workspace } from '../../../shared/protocol/protocol';
import { installChrome } from '../../testing/chrome-mock';
import { makeWorkspace } from '../../testing/fixtures';
import { installSendMenu } from './send-menu';

let fake: ReturnType<typeof installChrome>;
let list: Workspace[];
let sent: ControlToHelper[];
let menu: ReturnType<typeof installSendMenu>;

beforeEach(() => {
  fake = installChrome();
  list = [];
  sent = [];
  menu = installSendMenu({ workspaces: () => list, send: (message) => (sent.push(message), true) });
});
afterEach(() => vi.unstubAllGlobals());

const created = () => fake.mock.contextMenus.create.mock.calls.map(([item]) => (item as { id: string }).id);

describe('the menu', () => {
  it('lists the workspaces, rebuilding only when they change', async () => {
    const a = makeWorkspace({ id: 'ws-a', name: 'acme/app' });
    const b = makeWorkspace({ id: 'ws-b', name: 'acme/api' });
    list = [a, b];
    await menu.rebuild();
    expect(created()).toEqual(['send-to-workspace', 'send:ws-a', 'send:ws-b']);

    await menu.rebuild();
    expect(fake.mock.contextMenus.removeAll).toHaveBeenCalledTimes(1);

    list = [a];
    await menu.rebuild();
    expect(fake.mock.contextMenus.removeAll).toHaveBeenCalledTimes(2);
  });

  it('rebuilds when a workspace is renamed', async () => {
    list = [makeWorkspace({ id: 'ws-a', name: 'one' })];
    await menu.rebuild();
    list = [makeWorkspace({ id: 'ws-a', name: 'two' })];
    await menu.rebuild();
    expect(fake.mock.contextMenus.removeAll).toHaveBeenCalledTimes(2);
  });

  it('shows no menu without workspaces, and caps the list at twenty', async () => {
    await menu.rebuild();
    expect(fake.mock.contextMenus.create).not.toHaveBeenCalled();

    list = Array.from({ length: 25 }, (_, index) => makeWorkspace({ id: `ws-${index}`, name: `w${index}` }));
    await menu.rebuild();
    expect(fake.mock.contextMenus.create).toHaveBeenCalledTimes(21);
  });

  it('builds one menu at a time when asked again before the last build finished', async () => {
    list = [makeWorkspace({ id: 'ws-a' })];
    const first = menu.rebuild();
    list = [makeWorkspace({ id: 'ws-a' }), makeWorkspace({ id: 'ws-b' })];
    const second = menu.rebuild();
    await Promise.all([first, second]);
    // Each build clears the menu and then fills it, and the second waits for the first.
    const calls = [
      ...fake.mock.contextMenus.removeAll.mock.invocationCallOrder.map((order) => ({ order, what: 'clear' })),
      ...fake.mock.contextMenus.create.mock.invocationCallOrder.map((order, index) => ({ order, what: created()[index] })),
    ].sort((a, b) => a.order - b.order);
    expect(calls.map((call) => call.what)).toEqual(['clear', 'send-to-workspace', 'send:ws-a', 'clear', 'send-to-workspace', 'send:ws-a', 'send:ws-b']);
  });
});

describe('choosing a workspace', () => {
  const click = (info: Partial<chrome.contextMenus.OnClickData>, tab?: Partial<chrome.tabs.Tab>) =>
    fake.events.contextMenus.onClicked.emit({ menuItemId: 'send:ws-a', editable: false, ...info } as chrome.contextMenus.OnClickData, tab as chrome.tabs.Tab);

  it('sends the selection, else the link, else the page title and address', () => {
    click({ selectionText: '  some text  ', linkUrl: 'https://example.com/link' });
    click({ linkUrl: 'https://example.com/link' });
    click({ pageUrl: 'https://example.com/page' }, { title: 'A page' });
    click({}, { url: 'https://example.com/tab' });
    expect(sent.map((message) => (message as { text: string }).text)).toEqual([
      'some text',
      'https://example.com/link',
      'A page\nhttps://example.com/page',
      'https://example.com/tab',
    ]);
    expect(sent[0]).toMatchObject({ type: 'sendText', id: 'ws-a' });
  });

  it('ignores other menu items, and sends nothing when there is nothing to send', () => {
    fake.events.contextMenus.onClicked.emit({ menuItemId: 'other', selectionText: 'x', editable: false } as chrome.contextMenus.OnClickData, undefined);
    click({});
    expect(sent).toEqual([]);
  });
});
