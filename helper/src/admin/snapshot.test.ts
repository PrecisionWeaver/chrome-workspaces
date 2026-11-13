import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient } from '../../../shared/protocol/protocol';
import { localDay } from '../../../shared/usage/usage';
import { readProcesses, subtree } from '../platform/system';
import { connectControl, type Harness, opened, startHarness } from '../../testing/harness';
import { waitFor } from '../../testing/wait-for';

// The trend test names days, so it needs a known zone.
process.env.TZ = 'America/New_York';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => {
  await h.close();
});

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

/** Asks for snapshots until the given workspace's transcript has been counted, or gives up. */
async function snapshotOnceCounted(workspaceId: string, done: (snapshot: Extract<ControlToClient, { type: 'system' }>) => boolean) {
  for (let i = 0; i < 50; i++) {
    const { ws, reply } = await ask({ type: 'system' }, 'system');
    ws.close();
    if (reply.type !== 'system' || !reply.snapshot) throw new Error('no snapshot');
    if (done(reply)) return reply.snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`the transcript of ${workspaceId} was never counted`);
}

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

    const snapshot = await snapshotOnceCounted(workspace.id, (reply) => {
      expect(reply.snapshot!.sessions.find((x) => x.id === bare.id)!.tokens).toBeNull();
      const mine = reply.snapshot!.sessions.find((x) => x.id === workspace.id)!;
      return !!mine.tokens && !mine.tokens.counting && mine.tokens.output > 0;
    });
    // That transcript names no model, so there is no rate to price it with.
    const mine = snapshot.sessions.find((x) => x.id === workspace.id)!;
    expect(mine.tokens).toEqual({ input: 6, output: 75, cacheWrite: 200, cacheRead: 2000, counting: false, costUsd: 0 });
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

    const snapshot = await snapshotOnceCounted(workspace.id, (reply) => {
      const mine = reply.snapshot!.sessions.find((x) => x.id === workspace.id)!;
      return !!mine.tokens && !mine.tokens.counting && mine.tokens.output > 0;
    });
    const mine = snapshot.sessions.find((x) => x.id === workspace.id)!;
    // The harness prices opus at $10 in and $50 out per million: $10 + $50 for one counted message.
    expect(mine.tokens!.costUsd).toBeCloseTo(60);
    expect(snapshot.usage.daily).toHaveLength(60);
    expect(snapshot.usage.daily.at(-1)).toMatchObject({
      day: today,
      tokens: 2_000_000,
      output: 1_000_000,
      cacheRead: 0,
      models: [{ model: 'claude-opus-5-5', tokens: 2_000_000, costUsd: expect.closeTo(60) }],
    });
    expect(snapshot.usage.daily[0]).toMatchObject({ tokens: 0, models: [] });
    // The message was written at 10:00 local time today.
    expect(snapshot.usage.hourly).toHaveLength(24);
    expect(snapshot.usage.hourly[10]).toEqual({ hour: 10, tokens: 2_000_000, costUsd: expect.closeTo(60) });
    expect(snapshot.usage.hourly.filter((x) => x.tokens > 0)).toHaveLength(1);
    expect(snapshot.usage).toMatchObject({ costUsd: expect.closeTo(60), unpriced: [] });
    expect(snapshot.usage.workspaces).toEqual([{ id: workspace.id, name: 'priced', daily: [{ day: today, tokens: 2_000_000, costUsd: expect.closeTo(60) }] }]);
  });

  it('keeps counting an archived workspace, and a transcript a live workspace is on only once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-adm-archived-'));
    const wrote = new Date();
    wrote.setHours(10, 0, 0, 0);
    const today = localDay(wrote);
    const transcript = (name: string, id: string) => {
      const file = join(dir, name);
      const line = {
        type: 'assistant',
        timestamp: wrote.toISOString(),
        message: {
          id,
          model: 'claude-opus-5-5',
          usage: { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
      };
      writeFileSync(file, `${JSON.stringify(line)}\n`);
      return file;
    };
    const live = h.store.create({ name: 'live', cwd: h.defaultCwd });
    h.transcripts[live.id] = transcript('live.jsonl', 'm1');
    const gone = transcript('gone.jsonl', 'm2');
    h.archived = [
      { id: 'w-gone', name: 'gone', transcript: gone },
      // Its workspace was restored onto the live one's transcript: not a second count.
      { id: 'w-restored', name: 'restored', transcript: h.transcripts[live.id] },
    ];

    const snapshot = await snapshotOnceCounted(live.id, (reply) => !reply.snapshot!.usage.counting && !!reply.snapshot!.usage.daily.at(-1)?.tokens);
    expect(snapshot.usage.daily.at(-1)).toMatchObject({ day: today, tokens: 2_000_000 });
    expect(snapshot.usage.workspaces.map((w) => w.name).sort()).toEqual(['gone', 'live']);
    // Archived work is not a session of anyone's, so it has no row among the sessions.
    expect(snapshot.sessions.map((x) => x.id)).not.toContain('w-gone');
  });
});
