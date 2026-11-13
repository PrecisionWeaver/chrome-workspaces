import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient } from '../../../shared/protocol/protocol';
import { connectControl, opened, startHarness, type Harness } from '../../testing/harness';
import { waitFor } from '../../testing/wait-for';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

function lastState(messages: ControlToClient[]) {
  const states = messages.filter((m) => m.type === 'state');
  return states[states.length - 1];
}

const PR = 'https://github.com/acme/web-app/pull/482';

// Workspace and git requests have their own tests beside their handlers.
describe('control channel', () => {
  it('sends the current state on connect', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    h.statuses[a.id] = 'needs_input';
    const { ws, messages } = connectControl(h);
    await waitFor(() => messages.length > 0);
    expect(messages[0]).toEqual({
      type: 'state',
      workspaces: [expect.objectContaining({ id: a.id })],
      statuses: { [a.id]: 'needs_input' },
      waiting: {},
      reviews: { items: [], error: null, fetchedAt: null, refreshing: false },
    });
    ws.close();
  });

  it('pairs windows and records tabs, broadcasting the new state', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const { ws, messages } = connectControl(h);
    await opened(ws);

    ws.send(JSON.stringify({ type: 'pair', id: a.id, windowId: 7 }));
    ws.send(JSON.stringify({ type: 'tabs', windowId: 7, urls: ['https://x/1'] }));
    await waitFor(() => {
      const state = lastState(messages);
      return state?.type === 'state' && state.workspaces[0]?.lastTabUrls[0] === 'https://x/1';
    });
    expect(h.store.get(a.id)).toMatchObject({ windowId: 7, lastTabUrls: ['https://x/1'] });

    ws.send(JSON.stringify({ type: 'unpair', windowId: 7 }));
    await waitFor(() => h.store.get(a.id)?.windowId === null);
    ws.close();
  });

  it('records the tab group the extension reports, and keeps the window when the group goes', async () => {
    const b = h.store.create({ name: 'b', cwd: h.defaultCwd });
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'pair', id: b.id, windowId: 9, groupId: 44 }));
    await waitFor(() => h.store.get(b.id)?.groupId === 44);
    ws.send(JSON.stringify({ type: 'unpairGroup', groupId: 44 }));
    await waitFor(() => h.store.get(b.id)?.groupId === null);
    expect(h.store.get(b.id)?.windowId).toBe(9);
    ws.close();
  });

  it('removes a workspace and ends its terminal session', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const session = h.sessions.create({ id: a.id, command: '/bin/cat', args: [], cwd: h.defaultCwd });
    const shell = h.sessions.create({ id: `shell-${a.id}`, command: '/bin/cat', args: [], cwd: h.defaultCwd });
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'remove', id: a.id }));
    await waitFor(() => h.store.list().length === 0);
    await waitFor(() => session.exited);
    expect(h.sessions.get(a.id)).toBeUndefined();
    ws.close();
    await waitFor(() => shell.exited);
    expect(h.sessions.get(`shell-${a.id}`)).toBeUndefined();
  });

  it('survives a request the store could not save', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const { ws } = connectControl(h);
    await opened(ws);
    chmodSync(h.dataDir, 0o555);
    try {
      ws.send(JSON.stringify({ type: 'rename', id: a.id, name: 'lost' }));
      await sleep(100);
    } finally {
      chmodSync(h.dataDir, 0o755);
    }
    ws.send(JSON.stringify({ type: 'rename', id: a.id, name: 'kept' }));
    await waitFor(() => h.store.get(a.id)?.name === 'kept');
    ws.close();
  });

  it('ignores malformed messages without dropping the connection', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'pair', id: a.id, windowId: 'seven' }));
    ws.send(JSON.stringify({ type: 'pair', id: 'ws-unknown0', windowId: 1 }));
    ws.send(JSON.stringify({ type: 'pair', id: a.id, windowId: 3 }));
    await waitFor(() => h.store.get(a.id)?.windowId === 3);
    ws.close();
  });

  it('pastes sent text into a running terminal without submitting it, and says so when there is none', async () => {
    const running = h.store.create({ name: 'running', cwd: h.defaultCwd });
    const idle = h.store.create({ name: 'idle', cwd: h.defaultCwd });
    // `cat` echoes what it is given, so the paste shows up in the session's output.
    const session = h.sessions.create({ id: running.id, command: '/bin/cat', args: [], cwd: h.defaultCwd });
    let output = '';
    session.attach(
      (data) => (output += data),
      () => {},
    );

    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'sendText', id: running.id, text: 'https://example.com/a\u001b[201~ rm -rf ~' }));
    ws.send(JSON.stringify({ type: 'sendText', id: idle.id, text: 'hello' }));
    ws.send(JSON.stringify({ type: 'sendText', id: running.id, text: '' }));
    await waitFor(() => messages.filter((m) => m.type === 'sent').length === 2);

    const sent = messages.filter((m) => m.type === 'sent');
    expect(sent.find((m) => m.id === running.id)).toMatchObject({ ok: true });
    expect(sent.find((m) => m.id === idle.id)).toMatchObject({ ok: false, message: expect.stringContaining('no running terminal') });
    await waitFor(() => output.includes('example.com'));
    // The escape the page tried to smuggle in was stripped, and nothing submitted the line.
    expect(output).toContain('https://example.com/a[201~ rm -rf ~');
    expect(output).not.toContain('\x1b[201~ rm');
    ws.close();
  });

  it("lists a workspace's earlier conversations, and resumes one by ending the session with a reset", async () => {
    const workspace = h.store.create({ name: 'w', cwd: h.defaultCwd });
    const past = { id: '169128c8-8b10-48e0-993f-a743c8fad9ef', startedAt: '2026-01-01T10:00:00Z', status: null, firstPrompt: 'fix it' };
    h.pastSessions[workspace.id] = [past];
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'listSessions', id: workspace.id }));
    await waitFor(() => messages.some((m) => m.type === 'sessions'));
    expect(messages.find((m) => m.type === 'sessions')).toEqual({ type: 'sessions', id: workspace.id, sessions: [past] });

    ws.send(JSON.stringify({ type: 'resumeSession', id: workspace.id, sessionId: 'not-a-session' }));
    ws.send(JSON.stringify({ type: 'resumeSession', id: workspace.id, sessionId: past.id }));
    await waitFor(() => messages.some((m) => m.type === 'sessionReset'));
    expect(h.resumed).toEqual([[workspace.id, past.id]]);
    expect(messages.find((m) => m.type === 'sessionReset')).toEqual({ type: 'sessionReset', id: workspace.id });
    ws.close();
  });

  it("sends a workspace's recent activity from its transcript, and says so when there is none", async () => {
    const withTranscript = h.store.create({ name: 'busy', cwd: h.defaultCwd });
    const without = h.store.create({ name: 'new', cwd: h.defaultCwd });
    const file = join(mkdtempSync(join(tmpdir(), 'cw-ctl-tl-')), 't.jsonl');
    writeFileSync(
      file,
      `${[
        JSON.stringify({ type: 'user', timestamp: '2026-10-08T10:00:00Z', message: { role: 'user', content: 'fix the bug' } }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-08T10:00:03Z',
          message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a.ts' } }] },
        }),
      ].join('\n')}\n`,
    );
    h.transcripts[withTranscript.id] = file;

    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'timeline', id: withTranscript.id }));
    ws.send(JSON.stringify({ type: 'timeline', id: without.id }));
    ws.send(JSON.stringify({ type: 'timeline', id: 'ws-00000000' }));
    await waitFor(() => messages.filter((m) => m.type === 'timeline').length === 3);
    const replies = messages.filter((m): m is Extract<ControlToClient, { type: 'timeline' }> => m.type === 'timeline');
    expect(replies.find((m) => m.id === withTranscript.id)).toMatchObject({
      error: null,
      events: [
        { kind: 'you', summary: 'fix the bug' },
        { kind: 'tool', tool: 'Edit', file: '/repo/a.ts' },
      ],
    });
    expect(replies.find((m) => m.id === without.id)).toMatchObject({ events: [], error: expect.stringContaining('no claude session') });
    expect(replies.find((m) => m.id === 'ws-00000000')).toMatchObject({ events: [], error: expect.any(String) });
    ws.close();
  });

  it("follows a workspace's activity: a reply at once, another on every push, and none once it stops following", async () => {
    const busy = h.store.create({ name: 'busy', cwd: h.defaultCwd });
    const fresh = h.store.create({ name: 'new', cwd: h.defaultCwd });
    const file = join(mkdtempSync(join(tmpdir(), 'cw-ctl-act-')), 's.events.jsonl');
    writeFileSync(file, `${JSON.stringify({ at: '2026-10-08T10:00:00Z', event: 'UserPromptSubmit', promptId: 'p1', summary: 'fix the bug' })}\n`);
    h.activityFiles[busy.id] = file;

    const { ws, messages } = connectControl(h);
    await opened(ws);
    const replies = () => messages.filter((m): m is Extract<ControlToClient, { type: 'activity' }> => m.type === 'activity');
    ws.send(JSON.stringify({ type: 'activity', id: busy.id }));
    await waitFor(() => replies().length === 1);
    expect(replies()[0]).toMatchObject({ id: busy.id, error: null, items: [{ kind: 'turn', prompt: 'fix the bug', endedAt: null }] });

    writeFileSync(file, `${JSON.stringify({ at: '2026-10-08T10:00:05Z', event: 'Stop', promptId: 'p1' })}\n`, { flag: 'a' });
    h.control.pushActivity();
    await waitFor(() => replies().length === 2);
    expect(replies()[1].items[0]).toMatchObject({ endedAt: '2026-10-08T10:00:05Z' });

    ws.send(JSON.stringify({ type: 'activity', id: fresh.id }));
    await waitFor(() => replies().length === 3);
    expect(replies()[2]).toMatchObject({ id: fresh.id, items: [], error: expect.stringContaining('no claude session') });
    ws.send(JSON.stringify({ type: 'activity', id: 'ws-00000000' }));
    await waitFor(() => replies().length === 4);
    expect(replies()[3]).toMatchObject({ items: [], error: expect.any(String) });

    ws.send(JSON.stringify({ type: 'activity', id: null }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    h.control.pushActivity();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(replies().length).toBe(4);
    ws.close();
  });

  it('sends the review threads of a pull request, and says why when it cannot', async () => {
    const { ws, messages } = connectControl(h);
    await opened(ws);
    const replies = () => messages.filter((m): m is Extract<ControlToClient, { type: 'prThreads' }> => m.type === 'prThreads');

    ws.send(JSON.stringify({ type: 'prThreads', url: PR }));
    await waitFor(() => replies().length === 1);
    expect(replies()[0]).toMatchObject({ threads: [], error: 'gh failed' });

    h.prThreadsJson = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              totalCount: 1,
              nodes: [
                {
                  isResolved: false,
                  isOutdated: false,
                  path: 'a.ts',
                  line: 4,
                  comments: {
                    nodes: [{ author: { login: 'drew' }, body: 'Rename this', createdAt: '2026-10-08T10:00:00Z', url: 'https://github.com/x/y/pull/1#r1' }],
                  },
                },
              ],
            },
          },
        },
      },
    });
    ws.send(JSON.stringify({ type: 'prThreads', url: PR }));
    await waitFor(() => replies().length === 2);
    expect(replies()[1]).toMatchObject({ error: null, total: 1, threads: [{ path: 'a.ts', line: 4, comments: [{ author: 'drew', body: 'Rename this' }] }] });
    // Both requests went out for the same PR, split into the parts gh is given.
    expect(h.prThreadRequests).toEqual(['acme/web-app#482', 'acme/web-app#482']);

    // A URL that is not a pull request never reaches gh.
    const before = h.prThreadRequests.length;
    ws.send(JSON.stringify({ type: 'prThreads', url: 'https://evil.example/a/b/pull/1' }));
    ws.send(JSON.stringify({ type: 'system' }));
    await waitFor(() => messages.some((m) => m.type === 'system'));
    expect(h.prThreadRequests).toHaveLength(before);
    ws.close();
  });

  it('answers listRepos to the asking client only', async () => {
    h.repos.push({ name: 'chrome-workspaces', path: '/w/chrome-workspaces', root: 'Websites' });
    const asker = connectControl(h);
    const other = connectControl(h);
    await Promise.all([opened(asker.ws), opened(other.ws)]);
    asker.ws.send(JSON.stringify({ type: 'listRepos' }));
    await waitFor(() => asker.messages.some((m) => m.type === 'repos'));
    expect(asker.messages.find((m) => m.type === 'repos')).toEqual({ type: 'repos', repos: h.repos });
    expect(other.messages.some((m) => m.type === 'repos')).toBe(false);
    asker.ws.close();
    other.ws.close();
  });

  it('answers listTemplates with the team templates, reporting a file it cannot read', async () => {
    const template = { id: 'team:0', name: 'Review', repo: '/code/app', model: '', tabs: '', message: '', window: 'new' as const, worktree: false };
    h.teamTemplates.push(template);
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'listTemplates' }));
    await waitFor(() => messages.some((m) => m.type === 'templates'));
    expect(messages.find((m) => m.type === 'templates')).toEqual({ type: 'templates', templates: [template], error: null });
    h.templatesError = 'cannot read /team/templates.json';
    ws.send(JSON.stringify({ type: 'listTemplates' }));
    await waitFor(() => messages.filter((m) => m.type === 'templates').length === 2);
    expect(messages.filter((m) => m.type === 'templates')[1]).toEqual({ type: 'templates', templates: [], error: 'cannot read /team/templates.json' });
    ws.close();
  });

  it('answers listPrompts to the asking client only, reporting read errors', async () => {
    h.prompts.push({ section: 'Reviews', text: '/code-review PR-URL' });
    const asker = connectControl(h);
    const other = connectControl(h);
    await Promise.all([opened(asker.ws), opened(other.ws)]);
    asker.ws.send(JSON.stringify({ type: 'listPrompts' }));
    await waitFor(() => asker.messages.some((m) => m.type === 'prompts'));
    expect(asker.messages.find((m) => m.type === 'prompts')).toEqual({
      type: 'prompts',
      prompts: [{ section: 'Reviews', text: '/code-review PR-URL' }],
      error: null,
    });

    h.promptsError = 'cannot read /x.md: ENOENT';
    asker.ws.send(JSON.stringify({ type: 'listPrompts' }));
    await waitFor(() => asker.messages.filter((m) => m.type === 'prompts').length === 2);
    expect(asker.messages.filter((m) => m.type === 'prompts')[1]).toEqual({ type: 'prompts', prompts: [], error: 'cannot read /x.md: ENOENT' });
    expect(other.messages.some((m) => m.type === 'prompts')).toBe(false);
    asker.ws.close();
    other.ws.close();
  });

  it('refreshes review requests on request', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'refreshReviews' }));
    await waitFor(() => h.reviewRefreshes === 1);
    ws.close();
  });

  it('answers prDetails to the asking client, reporting fetch errors and ignoring non-PR urls', async () => {
    h.prDetailsJson = JSON.stringify({
      number: 482,
      title: 't',
      url: PR,
      author: { login: 'drew' },
      headRefName: 'h',
      baseRefName: 'b',
      isDraft: false,
      additions: 1,
      deletions: 2,
      changedFiles: 3,
      reviewDecision: 'APPROVED',
      mergeable: 'MERGEABLE',
      createdAt: 'c',
      updatedAt: 'u',
      latestReviews: [],
      reviewRequests: [],
      statusCheckRollup: [],
    });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'prDetails', url: 'https://evil.example/o/r/pull/1' }));
    ws.send(JSON.stringify({ type: 'prDetails', url: PR }));
    await waitFor(() => messages.some((m) => m.type === 'prDetails'));
    expect(messages.filter((m) => m.type === 'prDetails')).toEqual([
      { type: 'prDetails', url: PR, details: expect.objectContaining({ title: 't', reviewDecision: 'APPROVED' }), error: null },
    ]);
    expect(h.prDetailsRequests).toEqual([PR]);

    h.prDetailsJson = null;
    ws.send(JSON.stringify({ type: 'prDetails', url: PR }));
    await waitFor(() => messages.filter((m) => m.type === 'prDetails').length === 2);
    expect(messages.filter((m) => m.type === 'prDetails')[1]).toEqual({ type: 'prDetails', url: PR, details: null, error: 'gh failed' });
    ws.close();
  });
});
