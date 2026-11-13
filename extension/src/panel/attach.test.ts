// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../../testing/chrome-mock';
import { makeWorkspace } from '../../testing/fixtures';
import type { SessionHandlers, SessionLink, SessionTerminal } from '../terminal/terminal-session';
import { createSessionAttachment, type SessionAttachment } from './attach';

/** Each connection made, with the handlers the attachment gave it. */
const links: { session: string; handlers: SessionHandlers; link: SessionLink & { closed: boolean } }[] = [];
vi.mock('../terminal/terminal-session', () => ({
  connectSession: (session: string, _terminal: SessionTerminal, handlers: SessionHandlers) => {
    const link = { closed: false, send: vi.fn(() => true), close: vi.fn(() => void (link.closed = true)) };
    links.push({ session, handlers, link });
    return link;
  },
}));

const term = { reset: vi.fn(), focus: vi.fn(), paste: vi.fn(), write: vi.fn() };
const terminal = { term, refit: vi.fn(), output: vi.fn() } as unknown as SessionTerminal;
let fake: ReturnType<typeof installChrome>;
let attachment: SessionAttachment;
let terminalEl: HTMLDivElement;
let windowId: number | undefined;
const showNotice = vi.fn();
const ws = (id: string) => makeWorkspace({ id, name: `acme/${id}` });
const last = () => links.at(-1)!;

beforeEach(() => {
  fake = installChrome();
  links.length = 0;
  windowId = 7;
  for (const fn of [...Object.values(term), terminal.refit, showNotice]) (fn as ReturnType<typeof vi.fn>).mockClear();
  terminalEl = document.createElement('div');
  document.body.replaceChildren(terminalEl);
  attachment = createSessionAttachment({ terminal, terminalEl, windowId: () => windowId, showNotice });
});
afterEach(() => vi.unstubAllGlobals());

describe('attaching', () => {
  it('connects to the workspace’s session once, resetting the terminal', () => {
    attachment.attach(ws('a'));
    attachment.attach(ws('a'));
    expect(links.map((l) => l.session)).toEqual(['a']);
    expect(term.reset).toHaveBeenCalledTimes(1);
    expect(attachment.attachedId()).toBe('a');
  });

  it('drops the old connection when attaching to another workspace', () => {
    attachment.attach(ws('a'));
    const first = last().link;
    attachment.attach(ws('b'));
    expect(first.closed).toBe(true);
    expect(last().session).toBe('b');
  });

  it('detaches, after which nothing is sent', () => {
    attachment.attach(ws('a'));
    const link = last().link;
    expect(attachment.send({ type: 'input', data: 'x' })).toBe(true);
    attachment.detach();
    expect(link.closed).toBe(true);
    expect(attachment.attachedId()).toBeNull();
    expect(attachment.send({ type: 'input', data: 'x' })).toBe(false);
  });

  it('fits and focuses the terminal when the session opens', () => {
    attachment.attach(ws('a'));
    last().handlers.onOpen();
    expect(terminal.refit).toHaveBeenCalled();
    expect(term.focus).toHaveBeenCalled();
  });

  it('fits only while the terminal is showing', () => {
    terminalEl.hidden = true;
    attachment.fit();
    expect(terminal.refit).not.toHaveBeenCalled();
    terminalEl.hidden = false;
    attachment.fit();
    expect(terminal.refit).toHaveBeenCalledTimes(1);
  });
});

describe('messages from the session', () => {
  it('pastes the path of an uploaded file, or says why it failed', () => {
    attachment.attach(ws('a'));
    last().handlers.onMessage({ type: 'uploaded', name: 'shot.png', path: '/tmp/up/shot.png', error: null });
    expect(term.paste).toHaveBeenCalledWith('/tmp/up/shot.png ');
    last().handlers.onMessage({ type: 'uploaded', name: 'big.bin', path: null, error: 'too large' });
    expect(showNotice).toHaveBeenCalledWith('Could not add big.bin: too large');
    last().handlers.onMessage({ type: 'uploaded', name: 'x', path: null, error: null });
    expect(showNotice).toHaveBeenCalledWith('Could not add x: unknown error');
  });

  it('closes the side panel when the shell exits, or the window when it is not a panel', () => {
    attachment.attach(ws('a'));
    last().handlers.onMessage({ type: 'exit', code: 0 });
    expect(fake.mock.sidePanel.close).toHaveBeenCalledWith({ windowId: 7 });
    windowId = undefined;
    const close = vi.fn();
    vi.stubGlobal('window', Object.assign(Object.create(window), { close }));
    last().handlers.onMessage({ type: 'exit', code: 0 });
    expect(close).toHaveBeenCalled();
  });

  it('says so in the terminal when the helper drops the connection, and sends nothing after', () => {
    attachment.attach(ws('a'));
    last().handlers.onDisconnect();
    expect(term.write.mock.calls[0]![0]).toContain('disconnected from helper');
    expect(attachment.send({ type: 'input', data: 'x' })).toBe(false);
    // Still this workspace's, so the next state does not reattach until the link is back.
    expect(attachment.attachedId()).toBe('a');
  });

  it('forgets the workspace when the helper could not be reached, so the next attach tries again', () => {
    attachment.attach(ws('a'));
    last().handlers.onUnreachable();
    expect(attachment.attachedId()).toBeNull();
    attachment.attach(ws('a'));
    expect(links).toHaveLength(2);
  });
});
