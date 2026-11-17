import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../../shared/protocol/workspace';
import { installChrome } from '../../testing/chrome-mock';
import { makeWorkspace } from '../../testing/fixtures';
import { installAttention } from './attention';

let fake: ReturnType<typeof installChrome>;
let list: Workspace[];
let opened: Workspace[];
let attention: ReturnType<typeof installAttention>;

beforeEach(() => {
  fake = installChrome();
  list = [makeWorkspace({ id: 'ws-a', name: 'acme/app' }), makeWorkspace({ id: 'ws-b', name: 'acme/api' })];
  opened = [];
  attention = installAttention({ workspaces: () => list, open: (workspace) => opened.push(workspace) });
});
afterEach(() => vi.unstubAllGlobals());

const titles = () => fake.mock.notifications.create.mock.calls.map(([, options]) => (options as { title: string }).title);

describe('the badge', () => {
  it('counts the workspaces waiting for input, and clears when none are', async () => {
    await attention.announce({ 'ws-a': 'needs_input', 'ws-b': 'idle' }, {});
    expect(fake.mock.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1' });
    await attention.announce({ 'ws-a': 'working', 'ws-b': 'idle' }, {});
    expect(fake.mock.action.setBadgeText).toHaveBeenLastCalledWith({ text: '' });
  });
});

describe('notifications', () => {
  it('notify when a workspace starts waiting or finishes, if they are on, and not for the first state', async () => {
    fake.storage.local.prefs = { notify: true };
    await attention.announce({ 'ws-a': 'working', 'ws-b': 'working' }, {});
    expect(fake.mock.notifications.create).not.toHaveBeenCalled();
    await attention.announce({ 'ws-a': 'needs_input', 'ws-b': 'idle' }, {});
    expect(fake.mock.notifications.create).toHaveBeenCalledWith('ws-ws-a', expect.objectContaining({ title: 'acme/app needs your input' }));
    expect(fake.mock.notifications.create).toHaveBeenCalledWith('ws-ws-b', expect.objectContaining({ title: 'acme/api finished' }));
  });

  it('say what a waiting workspace wants, so a permission prompt can be told from a question', async () => {
    fake.storage.local.prefs = { notify: true };
    await attention.announce({ 'ws-a': 'working' }, {});
    await attention.announce({ 'ws-a': 'needs_input' }, { 'ws-a': { type: 'permission_prompt', message: 'Claude needs your permission to use Bash' } });
    expect(fake.mock.notifications.create).toHaveBeenCalledWith(
      'ws-ws-a',
      expect.objectContaining({ title: 'acme/app needs your permission', message: 'Claude needs your permission to use Bash' }),
    );
  });

  it('stay quiet when they are off, but the badge still counts', async () => {
    await attention.announce({ 'ws-a': 'working' }, {});
    await attention.announce({ 'ws-a': 'needs_input' }, {});
    expect(fake.mock.notifications.create).not.toHaveBeenCalled();
    expect(fake.mock.action.setBadgeText).toHaveBeenLastCalledWith({ text: '1' });
  });

  it('skip a workspace that is no longer listed', async () => {
    fake.storage.local.prefs = { notify: true };
    await attention.announce({ 'ws-a': 'working' }, {});
    list = [];
    await attention.announce({ 'ws-a': 'needs_input' }, {});
    expect(fake.mock.notifications.create).not.toHaveBeenCalled();
  });

  it('open the workspace when clicked, and dismiss the notification; an unknown one is only dismissed', () => {
    fake.events.notifications.onClicked.emit('ws-ws-a');
    expect(opened.map((ws) => ws.id)).toEqual(['ws-a']);
    expect(fake.mock.notifications.clear).toHaveBeenCalledWith('ws-ws-a');
    fake.events.notifications.onClicked.emit('ws-gone');
    expect(opened).toHaveLength(1);
    expect(fake.mock.notifications.clear).toHaveBeenCalledWith('ws-gone');
  });
});

describe('notifySent', () => {
  it('says whether text was sent to a workspace', () => {
    attention.notifySent({ type: 'sent', id: 'ws-a', ok: true, message: 'Pasted it into its terminal, not submitted.' });
    attention.notifySent({ type: 'sent', id: 'ws-a', ok: false, message: 'no terminal' });
    attention.notifySent({ type: 'sent', id: 'gone', ok: false, message: 'no terminal' });
    expect(titles()).toEqual(['Sent to acme/app', 'Could not send to acme/app', 'Could not send to workspace']);
    // The helper words the message, so a paste that was cut says so.
    expect(fake.mock.notifications.create.mock.calls[0][1]).toMatchObject({ message: 'Pasted it into its terminal, not submitted.' });
    expect(fake.mock.notifications.create.mock.calls[1][1]).toMatchObject({ message: 'no terminal' });
  });
});
