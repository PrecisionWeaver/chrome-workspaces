import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient } from '../../../shared/protocol/protocol';
import { readProcesses, subtree } from '../platform/system';
import { connectControl, type Harness, opened, startHarness } from '../../testing/harness';
import { waitFor } from '../../testing/wait-for';
import { checkUpdates, pruneWorktrees } from './actions';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Starts a workspace whose shell runs a long sleep, so there is a process tree beneath it. */
async function workspaceWithSleep(name: string) {
  const workspace = h.store.create({ name, cwd: h.defaultCwd });
  const session = h.sessions.create({ id: workspace.id, command: '/bin/sh', args: ['-c', 'sleep 300 & wait'], cwd: h.defaultCwd });
  // The shell forks its sleep a moment after it starts.
  for (let i = 0; i < 100 && subtree(await readProcesses(), session.pid!).length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return { workspace, session };
}

async function ask(request: unknown, replyType: ControlToClient['type']) {
  const { ws, messages } = connectControl(h);
  await opened(ws);
  ws.send(JSON.stringify(request));
  await waitFor(() => messages.some((m) => m.type === replyType));
  const reply = messages.find((m) => m.type === replyType)!;
  return { ws, messages, reply };
}

describe('updates', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();

  function installedWithNewCommit() {
    const root = mkdtempSync(join(tmpdir(), 'cw-adm-upd-'));
    const origin = join(root, 'origin.git');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    const seed = join(root, 'seed');
    // Not a clone: git warns about cloning an empty repository.
    git(root, 'init', '-q', '-b', 'main', seed);
    git(seed, 'remote', 'add', 'origin', origin);
    writeFileSync(join(seed, 'a.txt'), '1\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'first');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const installed = join(root, 'installed');
    git(root, 'clone', '-q', origin, installed);
    writeFileSync(join(seed, 'b.txt'), 'new\n');
    git(seed, 'add', '.');
    git(seed, 'commit', '-qm', 'a new feature');
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    return installed;
  }

  it('reports what an update brings, applies it, rebuilds, and restarts only when launchd manages the helper', async () => {
    h.repoDir = installedWithNewCommit();
    const checked = await ask({ type: 'checkUpdates' }, 'updates');
    expect(checked.reply).toMatchObject({ status: { behind: 1, canUpdate: true, commits: [{ subject: 'a new feature' }] }, error: null });
    checked.ws.close();

    const applied = await ask({ type: 'admin', request: { action: 'applyUpdate' } }, 'adminResult');
    expect(applied.reply).toMatchObject({ ok: true, message: expect.stringContaining('Updated') });
    expect(existsSync(join(h.repoDir, 'b.txt'))).toBe(true);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]).toContain('launchctl kickstart -k');
    applied.ws.close();
  });

  it('does not restart a helper that launchd does not manage, and says to do it by hand', async () => {
    h.repoDir = installedWithNewCommit();
    h.managed = false;
    const { reply } = await ask({ type: 'admin', request: { action: 'applyUpdate' } }, 'adminResult');
    expect(reply).toMatchObject({ ok: true, message: expect.stringContaining('Restart the helper by hand') });
    expect(h.spawned).toHaveLength(0);
  });

  it('explains when this copy is not a git checkout', async () => {
    h.repoDir = null;
    const checked = await ask({ type: 'checkUpdates' }, 'updates');
    expect(checked.reply).toMatchObject({ status: null, error: expect.stringContaining('not a git checkout') });
    const applied = await ask({ type: 'admin', request: { action: 'applyUpdate' } }, 'adminResult');
    expect(applied.reply).toMatchObject({ ok: false, message: expect.stringContaining('not a git checkout') });
    await expect(checkUpdates(null)).rejects.toThrow('not a git checkout');
  });
});

describe('killProcess', () => {
  it('stops a process inside the workspace, and only with a force when asked', async () => {
    const { workspace } = await workspaceWithSleep('a');
    const procs = (await ask({ type: 'system' }, 'system')).reply;
    if (procs.type !== 'system' || !procs.snapshot) throw new Error('no snapshot');
    const sleeper = procs.snapshot.sessions.find((s) => s.id === workspace.id)!.processes.find((p) => /^sleep 300/.test(p.command))!;
    expect(alive(sleeper.pid)).toBe(true);

    const { reply } = await ask({ type: 'admin', request: { action: 'killProcess', id: workspace.id, pid: sleeper.pid } }, 'adminResult');
    expect(reply).toMatchObject({ ok: true });
    await waitFor(() => !alive(sleeper.pid));
  });

  it('refuses the shell itself, the helper, and a process in another workspace or outside any', async () => {
    const a = await workspaceWithSleep('a');
    const b = await workspaceWithSleep('b');
    const outsider = spawn('sleep', ['300'], { stdio: 'ignore' });
    try {
      const attempts = [a.session.pid!, process.pid, outsider.pid!];
      for (const pid of attempts) {
        const { reply } = await ask({ type: 'admin', request: { action: 'killProcess', id: a.workspace.id, pid } }, 'adminResult');
        expect(reply).toMatchObject({ ok: false });
      }
      // b's shell belongs to b, not a.
      const { reply } = await ask({ type: 'admin', request: { action: 'killProcess', id: a.workspace.id, pid: b.session.pid! } }, 'adminResult');
      expect(reply).toMatchObject({ ok: false });
      expect(alive(outsider.pid!)).toBe(true);
      expect(alive(a.session.pid!)).toBe(true);
      expect(alive(b.session.pid!)).toBe(true);
    } finally {
      outsider.kill();
    }
  });

  it('says so for a workspace with no running session', async () => {
    const workspace = h.store.create({ name: 'idle', cwd: h.defaultCwd });
    const { reply } = await ask({ type: 'admin', request: { action: 'killProcess', id: workspace.id, pid: 2 } }, 'adminResult');
    expect(reply).toMatchObject({ ok: false, message: expect.stringContaining('no running session') });
  });

  it('drops a request with an unusable pid before it reaches the service', async () => {
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'admin', request: { action: 'killProcess', id: 'ws-x', pid: 1 } }));
    ws.send(JSON.stringify({ type: 'admin', request: { action: 'killProcess', id: 'ws-x', pid: 'abc' } }));
    ws.send(JSON.stringify({ type: 'admin', request: { action: 'rm -rf' } }));
    ws.send(JSON.stringify({ type: 'system' }));
    await waitFor(() => messages.some((m) => m.type === 'system'));
    expect(messages.some((m) => m.type === 'adminResult')).toBe(false);
    ws.close();
  });
});

describe('restartSession', () => {
  it('ends the shell and its processes, tells every panel to attach again, and does not announce an exit', async () => {
    const { workspace, session } = await workspaceWithSleep('r');
    const pid = session.pid!;
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'admin', request: { action: 'restartSession', id: workspace.id } }));
    await waitFor(() => messages.some((m) => m.type === 'sessionReset'));
    expect(messages.find((m) => m.type === 'sessionReset')).toEqual({ type: 'sessionReset', id: workspace.id });
    expect(messages.find((m) => m.type === 'adminResult')).toMatchObject({ ok: true });
    expect(h.sessions.get(workspace.id)).toBeUndefined();
    await waitFor(() => !alive(pid));
    ws.close();
  });

  it('says the session starts with the workspace when none was running', async () => {
    const workspace = h.store.create({ name: 'idle', cwd: h.defaultCwd });
    const { reply, messages } = await ask({ type: 'admin', request: { action: 'restartSession', id: workspace.id } }, 'adminResult');
    expect(reply).toMatchObject({ ok: true, message: expect.stringContaining('No session was running') });
    // Still a reset, so a panel that was attached to the old session attaches to the new one.
    expect(messages).toContainEqual({ type: 'sessionReset', id: workspace.id });
  });
});

describe('helper actions', () => {
  it('restarts and stops through launchd, after a delay, only when launchd manages it', async () => {
    await ask({ type: 'admin', request: { action: 'restartHelper' } }, 'adminResult');
    await ask({ type: 'admin', request: { action: 'stopHelper' } }, 'adminResult');
    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[0]).toMatch(/^sleep 1; launchctl kickstart -k gui\/\d+\/com\.chrome-workspaces\.helper$/);
    expect(h.spawned[1]).toMatch(/^sleep 1; launchctl bootout gui\/\d+\/com\.chrome-workspaces\.helper$/);

    h.managed = false;
    const restart = await ask({ type: 'admin', request: { action: 'restartHelper' } }, 'adminResult');
    expect(restart.reply).toMatchObject({ ok: false, message: expect.stringContaining('launchd') });
    const stop = await ask({ type: 'admin', request: { action: 'stopHelper' } }, 'adminResult');
    expect(stop.reply).toMatchObject({ ok: false, message: expect.stringContaining('launchd') });
    expect(h.spawned).toHaveLength(2);
  });
});

describe('housekeeping', () => {
  it('clears uploads and the log, and reports what it removed', async () => {
    mkdirSync(join(h.dataDir, 'uploads', 'ws-1'), { recursive: true });
    writeFileSync(join(h.dataDir, 'uploads', 'ws-1', 'a.png'), 'x'.repeat(100));
    writeFileSync(join(h.dataDir, 'helper.log'), 'line one\nline two\n');

    const log = await ask({ type: 'systemLog' }, 'systemLog');
    expect(log.reply).toMatchObject({ text: 'line one\nline two\n' });

    const cleared = await ask({ type: 'admin', request: { action: 'clearUploads' } }, 'adminResult');
    expect(cleared.reply).toMatchObject({ ok: true, message: expect.stringContaining('1 file') });
    expect(existsSync(join(h.dataDir, 'uploads', 'ws-1'))).toBe(false);

    await ask({ type: 'admin', request: { action: 'clearLog' } }, 'adminResult');
    expect(readFileSync(join(h.dataDir, 'helper.log'), 'utf8')).toBe('');
  });

  it("prunes a stale worktree record of a workspace's repository", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-prune-'));
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd });
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'f'), 'x');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'init');
    const tree = join(mkdtempSync(join(tmpdir(), 'cw-prune-wt-')), 'gone-tree');
    git(dir, 'worktree', 'add', '-q', '-b', 'topic', tree);
    execFileSync('rm', ['-rf', tree]);
    h.store.create({ name: 'p', cwd: dir });

    const { reply } = await ask({ type: 'admin', request: { action: 'pruneWorktrees' } }, 'adminResult');
    expect(reply).toMatchObject({ ok: true, message: expect.stringContaining('removed 1 stale') });
    expect(git(dir, 'worktree', 'list').toString().trim().split('\n')).toHaveLength(1);
  });

  it('skips a workspace folder that is missing or not a repository when pruning', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'cw-prune-plain-'));
    const result = await pruneWorktrees([{ cwd: plain }, { cwd: join(plain, 'gone') }]);
    expect(result).toEqual({ ok: true, message: 'Checked 0 repositories; removed 0 stale worktree records.' });
  });

  it('exports the workspaces and runs the GitHub check through a login shell', async () => {
    h.store.create({ name: 'exported', cwd: h.defaultCwd });
    const exported = await ask({ type: 'exportData' }, 'exportData');
    if (exported.reply.type !== 'exportData') throw new Error('wrong reply');
    expect(JSON.parse(exported.reply.json).workspaces[0].name).toBe('exported');

    const gh = await ask({ type: 'admin', request: { action: 'checkGh' } }, 'adminResult');
    expect(gh.reply).toMatchObject({ ok: true, message: 'ran: gh auth status 2>&1' });
  });
});
