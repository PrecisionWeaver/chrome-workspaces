import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient } from '../../shared/protocol';
import { readProcesses, subtree } from '../src/system';
import { emptyDay, usageByHour, usageTrend } from '../src/admin';
import { localDay } from '../../shared/usage';
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

describe('resource history', () => {
  it("samples a running session's whole shell tree, and drops it once the session has stopped", async () => {
    const { workspace } = await workspaceWithSleep('trend');
    await h.admin.sample(1_000);
    await h.admin.sample(61_000);
    const { ws, reply } = await ask({ type: 'system' }, 'system');
    if (reply.type !== 'system' || !reply.snapshot) throw new Error('no snapshot');
    const mine = reply.snapshot.sessions.find((s) => s.id === workspace.id)!;
    expect(mine.history.map((s) => s.t)).toEqual([1_000, 61_000]);
    // The shell and its sleep, so more than the shell alone would be.
    expect(mine.history[0].rssKb).toBe(mine.processes.reduce((sum, p) => sum + p.rssKb, 0));
    ws.close();

    h.sessions.remove(workspace.id);
    await h.admin.sample(121_000);
    const again = await ask({ type: 'system' }, 'system');
    if (again.reply.type !== 'system' || !again.reply.snapshot) throw new Error('no snapshot');
    expect(again.reply.snapshot.sessions.find((s) => s.id === workspace.id)!.history).toEqual([]);
    again.ws.close();
  });
});

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

describe('session tokens', () => {
  it("counts a workspace's transcript behind the snapshot, each message once, and has none for a workspace without one", async () => {
    const workspace = h.store.create({ name: 'counted', cwd: h.defaultCwd });
    const bare = h.store.create({ name: 'no transcript', cwd: h.defaultCwd });
    const file = join(mkdtempSync(join(tmpdir(), 'cw-adm-tok-')), 't.jsonl');
    const message = (id: string, out: number) =>
      JSON.stringify({
        type: 'assistant',
        message: { id, usage: { input_tokens: 3, output_tokens: out, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } },
      });
    writeFileSync(file, `${[message('a', 50), message('a', 50), message('b', 25)].join('\n')}\n`);
    h.transcripts[workspace.id] = file;

    let tokens: unknown = null;
    for (let i = 0; i < 50; i++) {
      const { ws, reply } = await ask({ type: 'system' }, 'system');
      ws.close();
      if (reply.type !== 'system' || !reply.snapshot) throw new Error('no snapshot');
      const mine = reply.snapshot.sessions.find((x) => x.id === workspace.id)!;
      expect(reply.snapshot.sessions.find((x) => x.id === bare.id)!.tokens).toBeNull();
      if (mine.tokens && !mine.tokens.counting && mine.tokens.output > 0) {
        tokens = mine.tokens;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // That transcript names no model, so there is no rate to price it with.
    expect(tokens).toEqual({ input: 6, output: 75, cacheWrite: 200, cacheRead: 2000, counting: false, costUsd: 0 });
  });
});

describe('warnings', () => {
  it('carries the guardrail findings and the limits they were judged by', async () => {
    await workspaceWithSleep('quiet');
    const { ws, reply } = await ask({ type: 'system' }, 'system');
    if (reply.type !== 'system' || !reply.snapshot) throw new Error('no snapshot');
    // A freshly started shell is neither big nor a long-running server.
    expect(reply.snapshot.warnings).toEqual([]);
    expect(reply.snapshot.config.limits).toEqual({ memoryWarnMb: 4096, idleServerHours: 4 });
    // No Jira site is configured in the harness, so ticket links stay hidden.
    expect(reply.snapshot.config.jiraBaseUrl).toBeNull();
    ws.close();
  });
});

describe('usage and cost', () => {
  // The trend test below names days, so it needs a known zone.
  process.env.TZ = 'America/New_York';

  it('prices a transcript by its model and puts each day in the trend, with quiet days as zero', async () => {
    const workspace = h.store.create({ name: 'priced', cwd: h.defaultCwd });
    const file = join(mkdtempSync(join(tmpdir(), 'cw-adm-cost-')), 't.jsonl');
    // Ten in the morning on the machine's own clock, whatever zone it is in.
    const wrote = new Date();
    wrote.setHours(10, 0, 0, 0);
    const today = localDay(wrote);
    const msg = (id: string, out: number) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: wrote.toISOString(),
        message: {
          id,
          model: 'claude-opus-5-5',
          usage: { input_tokens: 1_000_000, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      });
    writeFileSync(file, `${[msg('a', 1_000_000), msg('a', 1_000_000)].join('\n')}\n`);
    h.transcripts[workspace.id] = file;

    for (let i = 0; i < 50; i++) {
      const { ws, reply } = await ask({ type: 'system' }, 'system');
      ws.close();
      if (reply.type !== 'system' || !reply.snapshot) throw new Error('no snapshot');
      const mine = reply.snapshot.sessions.find((x) => x.id === workspace.id)!;
      if (mine.tokens && !mine.tokens.counting && mine.tokens.output > 0) {
        // The harness prices opus at $10 in and $50 out per million: $10 + $50 for one counted message.
        expect(mine.tokens.costUsd).toBeCloseTo(60);
        expect(reply.snapshot.usage.daily).toHaveLength(60);
        expect(reply.snapshot.usage.daily.at(-1)).toMatchObject({
          day: today,
          tokens: 2_000_000,
          output: 1_000_000,
          cacheRead: 0,
          models: [{ model: 'claude-opus-5-5', tokens: 2_000_000, costUsd: expect.closeTo(60) }],
        });
        expect(reply.snapshot.usage.daily[0]).toMatchObject({ tokens: 0, models: [] });
        // The message was written at 10:00 local time today.
        expect(reply.snapshot.usage.hourly).toHaveLength(24);
        expect(reply.snapshot.usage.hourly[10]).toEqual({ hour: 10, tokens: 2_000_000, costUsd: expect.closeTo(60) });
        expect(reply.snapshot.usage.hourly.filter((h) => h.tokens > 0)).toHaveLength(1);
        expect(reply.snapshot.usage).toMatchObject({ costUsd: expect.closeTo(60), unpriced: [] });
        expect(reply.snapshot.usage.workspaces).toEqual([
          { id: workspace.id, name: 'priced', daily: [{ day: today, tokens: 2_000_000, costUsd: expect.closeTo(60) }] },
        ]);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('the transcript was never counted');
  });

  it("builds a 60-day series ending today, and sums every day's cost", () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const day = (tokens: number, costUsd: number, models: [string, number, number][] = []) => ({
      ...emptyDay(),
      tokens,
      costUsd,
      output: tokens / 2,
      cacheRead: 7,
      models: new Map(models.map(([model, t, c]) => [model, { tokens: t, costUsd: c }])),
    });
    const trend = usageTrend(
      new Map([
        ['2026-10-09', day(5, 2, [['opus', 5, 2]])],
        ['2026-10-01', day(3, 1.5)],
        ['2025-01-01', day(9, 4)],
      ]),
      true,
      ['mystery-1'],
      now,
    );
    expect(trend.daily).toHaveLength(60);
    expect(trend.daily[0].day).toBe('2026-08-11');
    expect(trend.daily.at(-1)).toEqual({
      day: '2026-10-09',
      tokens: 5,
      costUsd: 2,
      output: 2.5,
      cacheRead: 7,
      models: [{ model: 'opus', tokens: 5, costUsd: 2 }],
    });
    expect(trend.daily.find((d) => d.day === '2026-10-01')).toMatchObject({ tokens: 3, models: [] });
    expect(trend.daily.find((d) => d.day === '2026-10-02')).toEqual({ day: '2026-10-02', tokens: 0, costUsd: 0, output: 0, cacheRead: 0, models: [] });
    // The total includes older days too; the series only reaches back sixty.
    expect(trend).toMatchObject({ costUsd: 7.5, counting: true, unpriced: ['mystery-1'] });
  });
});

describe('usageByHour', () => {
  it('lists all 24 hours, with those that had no use at zero', () => {
    const hours = usageByHour(
      new Map([
        [3, { tokens: 5, costUsd: 1 }],
        [23, { tokens: 7, costUsd: 0 }],
      ]),
    );
    expect(hours).toHaveLength(24);
    expect(hours.map((h) => h.hour)).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(hours[3]).toEqual({ hour: 3, tokens: 5, costUsd: 1 });
    expect(hours[23]).toEqual({ hour: 23, tokens: 7, costUsd: 0 });
    expect(hours[4]).toEqual({ hour: 4, tokens: 0, costUsd: 0 });
  });
});

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

  it('exports the workspaces and runs the GitHub check through a login shell', async () => {
    h.store.create({ name: 'exported', cwd: h.defaultCwd });
    const exported = await ask({ type: 'exportData' }, 'exportData');
    if (exported.reply.type !== 'exportData') throw new Error('wrong reply');
    expect(JSON.parse(exported.reply.json).workspaces[0].name).toBe('exported');

    const gh = await ask({ type: 'admin', request: { action: 'checkGh' } }, 'adminResult');
    expect(gh.reply).toMatchObject({ ok: true, message: 'ran: gh auth status 2>&1' });
  });
});
