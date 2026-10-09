import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient } from '../../shared/protocol';
import { readProcesses, subtree } from '../src/system';
import { connectControl, opened, startHarness, type Harness } from './harness';
import { waitFor } from './wait-for';

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

describe('system snapshot', () => {
  it('lists every workspace with its shell tree, the helper, storage and effective config', async () => {
    const { workspace, session } = await workspaceWithSleep('busy');
    const idle = h.store.create({ name: 'not started', cwd: join(h.defaultCwd, 'gone') });
    mkdirSync(join(h.dataDir, 'uploads', 'x'), { recursive: true });
    writeFileSync(join(h.dataDir, 'uploads', 'x', 'a.png'), '12345');

    const { ws, reply } = await ask({ type: 'system' }, 'system');
    if (reply.type !== 'system' || !reply.snapshot) throw new Error('no snapshot');
    const { snapshot } = reply;
    expect(snapshot.helper).toMatchObject({ pid: process.pid, port: 4178, commit: 'abc1234', managed: true });
    expect(snapshot.config.defaultCwd).toBe(h.defaultCwd);
    expect(snapshot.storage.uploadsBytes).toBe(5);

    const busy = snapshot.sessions.find((s) => s.id === workspace.id)!;
    expect(busy.pid).toBe(session.pid);
    expect(busy.processes[0].pid).toBe(session.pid);
    expect(busy.processes.some((p) => /^sleep 300/.test(p.command))).toBe(true);
    const stopped = snapshot.sessions.find((s) => s.id === idle.id)!;
    expect(stopped).toMatchObject({ pid: null, processes: [], cwdMissing: true });
    ws.close();
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
});

describe('helper actions', () => {
  it('restarts and stops through launchd, after a delay, only when launchd manages it', async () => {
    await ask({ type: 'admin', request: { action: 'restartHelper' } }, 'adminResult');
    await ask({ type: 'admin', request: { action: 'stopHelper' } }, 'adminResult');
    expect(h.spawned).toHaveLength(2);
    expect(h.spawned[0]).toMatch(/^sleep 1; launchctl kickstart -k gui\/\d+\/com\.chrome-workspaces\.helper$/);
    expect(h.spawned[1]).toMatch(/^sleep 1; launchctl bootout gui\/\d+\/com\.chrome-workspaces\.helper$/);

    h.managed = false;
    const { reply } = await ask({ type: 'admin', request: { action: 'restartHelper' } }, 'adminResult');
    expect(reply).toMatchObject({ ok: false, message: expect.stringContaining('launchd') });
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

  it('prunes a stale worktree record of a workspace\'s repository', async () => {
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

  it('exports the workspaces and runs the GitHub check through a login shell', async () => {
    h.store.create({ name: 'exported', cwd: h.defaultCwd });
    const exported = await ask({ type: 'exportData' }, 'exportData');
    if (exported.reply.type !== 'exportData') throw new Error('wrong reply');
    expect(JSON.parse(exported.reply.json).workspaces[0].name).toBe('exported');

    const gh = await ask({ type: 'admin', request: { action: 'checkGh' } }, 'adminResult');
    expect(gh.reply).toMatchObject({ ok: true, message: 'ran: gh auth status 2>&1' });
  });
});
