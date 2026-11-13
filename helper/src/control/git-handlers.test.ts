import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient } from '../../../shared/protocol/protocol';
import { connectControl, gitRepo, opened, startHarness, type Harness } from '../../testing/harness';
import { waitFor } from '../../testing/wait-for';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });

/** A repository with one commit of `f.txt`, and an unstaged second line in it. */
function repoWithChange(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-ctl-git-'));
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'f.txt'), 'x\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  writeFileSync(join(dir, 'f.txt'), 'x\ny\n');
  return dir;
}

describe('git requests over the control channel', () => {
  it("answers git requests for a workspace's directory, to the asking client only", async () => {
    const dir = repoWithChange();
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

  it('stages, commits, switches branch and compares over the channel, and drops a malformed write', async () => {
    const dir = repoWithChange();
    git(dir, 'branch', 'topic');
    const workspace = h.store.create({ name: 'w', cwd: dir });

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

  it('unstages and discards changes, answering with the result of each', async () => {
    const dir = repoWithChange();
    const workspace = h.store.create({ name: 'w', cwd: dir });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    const results = () => messages.filter((m): m is Extract<ControlToClient, { type: 'gitResult' }> => m.type === 'gitResult');

    ws.send(JSON.stringify({ type: 'gitStage', id: workspace.id, paths: ['f.txt'], stage: true }));
    await waitFor(() => results().length === 1);
    ws.send(JSON.stringify({ type: 'gitStage', id: workspace.id, paths: ['f.txt'], stage: false }));
    await waitFor(() => results().length === 2);
    expect(results()[1]).toMatchObject({ action: 'unstage', ok: true });
    expect(git(dir, 'diff', '--cached', '--name-only').trim()).toBe('');

    ws.send(JSON.stringify({ type: 'gitDiscard', id: workspace.id, paths: ['f.txt'] }));
    await waitFor(() => results().length === 3);
    expect(results()[2]).toMatchObject({ action: 'discard', ok: true });
    expect(readFileSync(join(dir, 'f.txt'), 'utf8')).toBe('x\n');
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

  it('pushes a branch, and makes a pull request for it after pushing', async () => {
    const dir = gitRepo();
    const remote = mkdtempSync(join(tmpdir(), 'cw-remote-'));
    execFileSync('git', ['init', '-q', '--bare'], { cwd: remote });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
    const workspace = h.store.create({ name: 'w', cwd: dir });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    const results = () => messages.filter((m): m is Extract<ControlToClient, { type: 'gitResult' }> => m.type === 'gitResult');

    ws.send(JSON.stringify({ type: 'gitPush', id: workspace.id }));
    await waitFor(() => results().length === 1);
    expect(results()[0]).toMatchObject({ action: 'push', ok: true, message: 'Pushed main to origin.' });
    expect(execFileSync('git', ['log', '--oneline', 'main'], { cwd: remote, encoding: 'utf8' }).trim().split('\n')).toHaveLength(2);

    ws.send(JSON.stringify({ type: 'gitCreatePr', id: workspace.id }));
    await waitFor(() => results().length === 2);
    expect(results()[1]).toMatchObject({ action: 'pr', ok: false, message: expect.stringContaining('already exists') });
    h.createdPrUrl = 'https://github.com/acme/web-app/pull/7';
    ws.send(JSON.stringify({ type: 'gitCreatePr', id: workspace.id }));
    await waitFor(() => results().length === 3);
    expect(results()[2]).toEqual({
      type: 'gitResult',
      id: workspace.id,
      action: 'pr',
      ok: true,
      message: 'Opened https://github.com/acme/web-app/pull/7',
      url: 'https://github.com/acme/web-app/pull/7',
    });
    ws.close();
  });
});
