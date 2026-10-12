import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient, ReviewRequest } from '../../shared/protocol';
import { connectControl, opened, startHarness, type Harness } from './harness';
import { waitFor } from './wait-for';

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
const review: ReviewRequest = {
  repo: 'acme/web-app',
  number: 482,
  title: 'PROJ-9 - x',
  url: PR,
  author: 'drew',
  isDraft: false,
  updatedAt: '2026-10-01T00:00:00Z',
  ticket: 'PROJ-9',
  merge: 'unknown',
  mergeReason: null,
};

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

  it('creates a workspace in the current window when asked from an unpaired panel', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'scratch', windowId: 9 }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0]).toMatchObject({ name: 'scratch', windowId: 9, cwd: h.defaultCwd });
    ws.close();
  });

  it('opens a new window for a workspace created without one', async () => {
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'scratch', windowId: null }));
    await waitFor(() => messages.some((m) => m.type === 'open'));
    ws.close();
  });

  it('removes a workspace and ends its terminal session', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const session = h.sessions.create({ id: a.id, command: '/bin/cat', args: [], cwd: h.defaultCwd });
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'remove', id: a.id }));
    await waitFor(() => h.store.list().length === 0);
    await waitFor(() => session.exited);
    expect(h.sessions.get(a.id)).toBeUndefined();
    ws.close();
  });

  it('renames a workspace, trimming the name and ignoring blank or overlong ones', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'rename', id: a.id, name: '   ' }));
    ws.send(JSON.stringify({ type: 'rename', id: a.id, name: 'x'.repeat(81) }));
    ws.send(JSON.stringify({ type: 'rename', id: 'ws-unknown0', name: 'nope' }));
    ws.send(JSON.stringify({ type: 'rename', id: a.id, name: '  Checkout bug  ' }));
    await waitFor(() => h.store.get(a.id)?.name === 'Checkout bug');
    ws.close();
  });

  it('moves a workspace, ignoring unknown ids and bad indexes', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((name) => h.store.create({ name, cwd: h.defaultCwd }));
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'move', id: a.id, index: -1 }));
    ws.send(JSON.stringify({ type: 'move', id: a.id, index: 1.5 }));
    ws.send(JSON.stringify({ type: 'move', id: 'ws-unknown0', index: 0 }));
    ws.send(JSON.stringify({ type: 'move', id: c.id, index: 0 }));
    await waitFor(() => h.store.list()[0]?.id === c.id);
    expect(h.store.list().map((w) => w.id)).toEqual([c.id, a.id, b.id]);
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

  it('creates a PR workspace in its repo directory with the prompt, and opens it', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'cw-repo-'));
    h.reviews.push(review);
    h.repoDirs['acme/web-app'] = repoDir;
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'web-app#482', windowId: null, pr: PR, prompt: `  /code-review ${PR}  ` }));
    await waitFor(() => messages.some((m) => m.type === 'open'));
    expect(h.store.list()[0]).toMatchObject({ name: 'web-app#482', ticket: 'PROJ-9', cwd: repoDir, url: PR, pr: PR, prompt: `/code-review ${PR}` });
    ws.close();
  });

  it('focuses the existing workspace for a PR instead of creating another', async () => {
    const existing = h.store.create({ name: 'mine', cwd: h.defaultCwd, pr: PR });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'web-app#482', windowId: null, pr: PR, prompt: 'x' }));
    await waitFor(() => messages.some((m) => m.type === 'focus' && m.id === existing.id));
    expect(h.store.list()).toHaveLength(1);
    ws.close();
  });

  it('creates a prompt-only workspace in the default directory', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'triage', windowId: null, prompt: 'Dig into this prod issue' }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0]).toMatchObject({ name: 'triage', cwd: h.defaultCwd, pr: null, prompt: 'Dig into this prod issue' });
    ws.close();
  });

  it('ignores a create with a non-PR url or an overlong prompt', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'a', windowId: null, pr: 'https://evil.example/o/r/pull/1' }));
    ws.send(JSON.stringify({ type: 'create', name: 'b', windowId: null, prompt: 'x'.repeat(8001) }));
    ws.send(JSON.stringify({ type: 'create', name: 'c', windowId: null }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0].name).toBe('c');
    ws.close();
  });

  it('asks for a tab group when a workspace joins a window, and records the pairing the extension reports', async () => {
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'a', windowId: 9 }));
    ws.send(JSON.stringify({ type: 'create', name: 'b', windowId: 9, group: true }));
    await waitFor(() => h.store.list().length === 2);
    const [a, b] = h.store.list();
    expect([a.windowId, b.windowId]).toEqual([9, 9]);
    await waitFor(() => messages.some((m) => m.type === 'group'));
    expect(messages.filter((m) => m.type === 'group')).toEqual([{ type: 'group', id: b.id }]);

    ws.send(JSON.stringify({ type: 'pair', id: b.id, windowId: 9, groupId: 44 }));
    await waitFor(() => h.store.get(b.id)?.groupId === 44);
    ws.send(JSON.stringify({ type: 'unpairGroup', groupId: 44 }));
    await waitFor(() => h.store.get(b.id)?.groupId === null);
    expect(h.store.get(b.id)?.windowId).toBe(9);
    ws.close();
  });

  it('starts a workspace with the tabs it was given, and ignores a request with a bad one', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'bad', windowId: null, urls: ['https://a.example', 'javascript:alert(1)'] }));
    ws.send(JSON.stringify({ type: 'create', name: 'many', windowId: null, urls: Array.from({ length: 21 }, (_, i) => `https://x.example/${i}`) }));
    ws.send(JSON.stringify({ type: 'create', name: 'ok', windowId: null, urls: ['https://a.example', 'http://b.example/path?q=1'] }));
    await waitFor(() => h.store.list().length >= 1);
    expect(h.store.list().map((w) => [w.name, w.lastTabUrls])).toEqual([['ok', ['https://a.example', 'http://b.example/path?q=1']]]);
    ws.close();
  });

  it('rejects a model that is not a plain id', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'bad', windowId: null, model: "x'; rm -rf ~" }));
    ws.send(JSON.stringify({ type: 'create', name: 'ok', windowId: null, model: 'sonnet' }));
    await waitFor(() => h.store.list().length >= 1);
    expect(h.store.list().map((w) => w.name)).toEqual(['ok']);
    ws.close();
  });

  it("starts a PR workspace in the directory picked, else its repo's configured one", async () => {
    const picked = mkdtempSync(join(tmpdir(), 'cw-pick-'));
    const repoDir = mkdtempSync(join(tmpdir(), 'cw-repo-'));
    h.repoDirs['acme/web-app'] = repoDir;
    h.reviews.push(review);
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'web-app#482', windowId: null, pr: PR, cwd: picked }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0].cwd).toBe(picked);
    h.store.remove(h.store.list()[0].id);
    ws.send(JSON.stringify({ type: 'create', name: 'web-app#482', windowId: null, pr: PR }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0].cwd).toBe(repoDir);
    ws.close();
  });

  it("answers git requests for a workspace's directory, to the asking client only", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-ctl-git-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'f.txt'), 'x\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    writeFileSync(join(dir, 'f.txt'), 'x\ny\n');
    const workspace = h.store.create({ name: 'g', cwd: dir });
    const plain = h.store.create({ name: 'plain', cwd: mkdtempSync(join(tmpdir(), 'cw-ctl-nogit-')) });

    const asker = connectControl(h);
    const other = connectControl(h);
    await Promise.all([opened(asker.ws), opened(other.ws)]);
    asker.ws.send(JSON.stringify({ type: 'git', id: workspace.id }));
    asker.ws.send(JSON.stringify({ type: 'git', id: plain.id }));
    asker.ws.send(JSON.stringify({ type: 'git', id: 'ws-00000000' }));
    asker.ws.send(JSON.stringify({ type: 'gitDiff', id: workspace.id, path: 'f.txt' }));
    asker.ws.send(JSON.stringify({ type: 'gitDiff', id: workspace.id, path: '../x' }));
    asker.ws.send(JSON.stringify({ type: 'gitCommit', id: workspace.id, sha: '--output=x' }));
    await waitFor(() => asker.messages.filter((m) => m.type === 'git' || m.type === 'gitDiff').length === 5);

    const replies = asker.messages.filter((m) => m.type === 'git' || m.type === 'gitDiff');
    const stateReply = replies.find((m) => m.type === 'git' && m.id === workspace.id);
    expect(stateReply).toMatchObject({ state: { branch: 'main', files: [{ path: 'f.txt', worktree: 'M' }], commits: [{ subject: 'init' }] }, error: null });
    expect(replies.find((m) => m.type === 'git' && m.id === plain.id)).toMatchObject({ state: null, error: expect.any(String) });
    expect(replies.find((m) => m.type === 'git' && m.id === 'ws-00000000')).toMatchObject({ state: null, error: 'unknown workspace' });
    expect(replies.find((m) => m.type === 'gitDiff' && m.path === 'f.txt')).toMatchObject({ diff: expect.stringContaining('+y'), error: null });
    expect(replies.find((m) => m.type === 'gitDiff' && m.path === '../x')).toMatchObject({ diff: '', error: expect.stringContaining('path') });
    // A malformed commit id is dropped before it reaches git.
    expect(asker.messages.some((m) => m.type === 'gitCommit')).toBe(false);
    expect(other.messages.some((m) => m.type === 'git' || m.type === 'gitDiff')).toBe(false);
    asker.ws.close();
    other.ws.close();
  });

  it("shows the worktree claude has moved into, but only one of the workspace's own repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-wt-main-'));
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd });
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'f.txt'), 'x\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    const tree = join(mkdtempSync(join(tmpdir(), 'cw-wt-')), 'feature-tree');
    git(dir, 'worktree', 'add', '-q', '-b', 'feature', tree);
    const stranger = mkdtempSync(join(tmpdir(), 'cw-other-'));
    git(stranger, 'init', '-q', '-b', 'elsewhere');
    const workspace = h.store.create({ name: 'w', cwd: dir });

    const { ws, messages } = connectControl(h);
    await opened(ws);
    const branchAfter = async (n: number) => {
      await waitFor(() => messages.filter((m) => m.type === 'git').length === n);
      const reply = messages.filter((m) => m.type === 'git')[n - 1];
      return reply.type === 'git' ? reply.state?.branch : undefined;
    };

    ws.send(JSON.stringify({ type: 'git', id: workspace.id }));
    expect(await branchAfter(1)).toBe('main');
    h.workingDirs[workspace.id] = tree;
    ws.send(JSON.stringify({ type: 'git', id: workspace.id }));
    expect(await branchAfter(2)).toBe('feature');
    // A directory outside the repository, or one that does not exist, is ignored.
    h.workingDirs[workspace.id] = stranger;
    ws.send(JSON.stringify({ type: 'git', id: workspace.id }));
    expect(await branchAfter(3)).toBe('main');
    h.workingDirs[workspace.id] = '/no/such/dir';
    ws.send(JSON.stringify({ type: 'git', id: workspace.id }));
    expect(await branchAfter(4)).toBe('main');
    ws.close();
  });

  it('reorders the whole list in one step, and ignores an order that is not the current workspaces', async () => {
    const [a, b, c] = ['a', 'b', 'c'].map((name) => h.store.create({ name, cwd: h.defaultCwd }));
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'order', ids: [b.id, a.id] }));
    ws.send(JSON.stringify({ type: 'order', ids: [c.id, a.id, b.id] }));
    await waitFor(() => h.store.list()[0].id === c.id);
    expect(h.store.list().map((w) => w.name)).toEqual(['c', 'a', 'b']);
    ws.close();
  });

  it('marks a workspace, and drops a mark with a color that is not one of ours', async () => {
    const a = h.store.create({ name: 'a', cwd: h.defaultCwd });
    const b = h.store.create({ name: 'b', cwd: h.defaultCwd });
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'mark', id: b.id, color: 'hotpink' }));
    ws.send(JSON.stringify({ type: 'mark', id: b.id, pinned: 'yes' }));
    ws.send(JSON.stringify({ type: 'mark', id: b.id, pinned: true, color: 'green' }));
    ws.send(JSON.stringify({ type: 'mark', id: a.id, archived: true }));
    await waitFor(() => h.store.get(a.id)?.archived === true);
    expect(h.store.list().map((w) => [w.name, w.pinned, w.color])).toEqual([
      ['b', true, 'green'],
      ['a', false, null],
    ]);
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

  it('stages, commits, switches branch and compares over the channel, and drops a malformed write', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-ctl-write-'));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'f.txt'), 'x\n');
    git('add', '.');
    git('commit', '-qm', 'init');
    git('branch', 'topic');
    const workspace = h.store.create({ name: 'w', cwd: dir });
    writeFileSync(join(dir, 'f.txt'), 'x\ny\n');

    const { ws, messages } = connectControl(h);
    await opened(ws);
    const results = () => messages.filter((m): m is Extract<ControlToClient, { type: 'gitResult' }> => m.type === 'gitResult');
    const next = async (count: number) => {
      await waitFor(() => results().length === count);
      return results()[count - 1];
    };

    ws.send(JSON.stringify({ type: 'gitStage', id: workspace.id, paths: ['f.txt'], stage: true }));
    expect(await next(1)).toMatchObject({ action: 'stage', ok: true });
    ws.send(JSON.stringify({ type: 'gitSave', id: workspace.id, message: 'change f' }));
    expect(await next(2)).toMatchObject({ action: 'commit', ok: true, message: expect.stringContaining('change f') });
    ws.send(JSON.stringify({ type: 'gitSave', id: workspace.id, message: 'again' }));
    expect(await next(3)).toMatchObject({ action: 'commit', ok: false, message: 'nothing is staged' });
    ws.send(JSON.stringify({ type: 'gitStage', id: workspace.id, paths: ['../escape'], stage: true }));
    expect(await next(4)).toMatchObject({ ok: false, message: expect.stringContaining('path') });
    ws.send(JSON.stringify({ type: 'gitSwitch', id: workspace.id, branch: 'topic' }));
    expect(await next(5)).toMatchObject({ action: 'switch', ok: true });
    ws.send(JSON.stringify({ type: 'gitSwitch', id: 'ws-00000000', branch: 'topic' }));
    expect(await next(6)).toMatchObject({ ok: false, message: 'unknown workspace' });

    ws.send(JSON.stringify({ type: 'gitBranches', id: workspace.id }));
    ws.send(JSON.stringify({ type: 'gitCompare', id: workspace.id }));
    await waitFor(() => messages.some((m) => m.type === 'gitBranches') && messages.some((m) => m.type === 'gitCompare'));
    expect(messages.find((m) => m.type === 'gitBranches')).toMatchObject({
      branches: expect.arrayContaining([expect.objectContaining({ name: 'topic', current: true })]),
    });
    expect(messages.find((m) => m.type === 'gitCompare')).toMatchObject({ compare: { base: 'main', ahead: 0 }, error: null });

    // Malformed writes never reach git: no reply of any kind.
    const before = messages.length;
    ws.send(JSON.stringify({ type: 'gitStage', id: workspace.id, paths: 'f.txt', stage: true }));
    ws.send(JSON.stringify({ type: 'gitDiscard', id: workspace.id, paths: [''] }));
    ws.send(JSON.stringify({ type: 'gitSave', id: workspace.id, message: 5 }));
    ws.send(JSON.stringify({ type: 'gitSwitch', id: workspace.id, branch: '' }));
    ws.send(JSON.stringify({ type: 'system' }));
    await waitFor(() => messages.length > before);
    expect(messages.slice(before).every((m) => m.type === 'system')).toBe(true);
    ws.close();
  });

  it("reports the checks on the branch's pull request, none when it has no PR, and an error when gh fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-ctl-ci-'));
    const workspace = h.store.create({ name: 'ci', cwd: dir });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    const checks = () => messages.filter((m): m is Extract<ControlToClient, { type: 'gitChecks' }> => m.type === 'gitChecks');

    ws.send(JSON.stringify({ type: 'gitChecks', id: workspace.id }));
    await waitFor(() => checks().length === 1);
    expect(checks()[0]).toMatchObject({ pr: null, checks: null, error: null });

    h.branchPrJson = JSON.stringify({
      number: 5,
      title: 'T',
      url: 'https://github.com/acme/web-app/pull/5',
      isDraft: false,
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'Pest', status: 'COMPLETED', conclusion: 'FAILURE' },
        { __typename: 'CheckRun', name: 'Lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
    });
    ws.send(JSON.stringify({ type: 'gitChecks', id: workspace.id }));
    await waitFor(() => checks().length === 2);
    expect(checks()[1]).toMatchObject({ pr: { number: 5 }, checks: { passed: 1, failed: 1, failing: ['Pest'] }, error: null });
    ws.close();
  });

  it("sends a workspace's recent activity from its transcript, and says so when there is none", async () => {
    const withTranscript = h.store.create({ name: 'busy', cwd: h.defaultCwd });
    const without = h.store.create({ name: 'new', cwd: h.defaultCwd });
    const file = join(mkdtempSync(join(tmpdir(), 'cw-ctl-tl-')), 't.jsonl');
    writeFileSync(
      file,
      [
        JSON.stringify({ type: 'user', timestamp: '2026-10-08T10:00:00Z', message: { role: 'user', content: 'fix the bug' } }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-10-08T10:00:03Z',
          message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: { file_path: '/repo/a.ts' } }] },
        }),
      ].join('\n') + '\n',
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

  it('starts a workspace in the given directory, falling back to the default when it is not one', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'cw-repo-'));
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'here', windowId: null, cwd: repo }));
    ws.send(JSON.stringify({ type: 'create', name: 'bad', windowId: null, cwd: '/no/such/dir' }));
    ws.send(JSON.stringify({ type: 'create', name: 'relative', windowId: null, cwd: 'repo' }));
    await waitFor(() => h.store.list().length === 3);
    expect(h.store.list().map((w) => [w.name, w.cwd])).toEqual([
      ['here', repo],
      ['bad', h.defaultCwd],
      ['relative', h.defaultCwd],
    ]);
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
