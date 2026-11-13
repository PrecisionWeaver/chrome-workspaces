import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient } from '../../../shared/protocol/protocol';
import { readProcesses, subtree } from '../platform/system';
import { connectControl, type Harness, opened, startHarness } from '../../testing/harness';
import { waitFor } from '../../testing/wait-for';

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
    expect(snapshot.config).toMatchObject({
      promptsFiles: ['/team/prompts.md'],
      templatesFile: '/team/templates.json',
      claudeArgs: ['--permission-mode', 'acceptEdits'],
    });
    expect(snapshot.storage.uploadsBytes).toBe(5);

    const busy = snapshot.sessions.find((s) => s.id === workspace.id)!;
    expect(busy.pid).toBe(session.pid);
    expect(busy.processes[0].pid).toBe(session.pid);
    expect(busy.processes.some((p) => /^sleep 300/.test(p.command))).toBe(true);
    const stopped = snapshot.sessions.find((s) => s.id === idle.id)!;
    expect(stopped).toMatchObject({ pid: null, processes: [], cwdMissing: true });
    ws.close();
  });

  it('gives the timeline, the log tail and the data export from the same service', async () => {
    const workspace = h.store.create({ name: 'acme/app', cwd: h.defaultCwd });
    expect(h.admin.timeline(workspace.id)).toBeNull();
    expect(h.admin.log()).toBe('');
    expect(JSON.parse(h.admin.exportData())).toMatchObject({ workspaces: [{ name: 'acme/app' }] });
  });
});
