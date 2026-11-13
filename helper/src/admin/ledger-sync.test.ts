import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient } from '../../../shared/protocol/protocol';
import { TranscriptTokens } from '../claude/tokens';
import { type LedgerEntry, UsageLedger } from '../claude/usage-ledger';
import { connectControl, type Harness, opened, startHarness } from '../../testing/harness';
import { waitFor } from '../../testing/wait-for';
import { createLedgerSync } from './ledger-sync';

const hour = 60 * 60 * 1000;

/** A transcript line for one million-token message written at `at` epoch milliseconds. */
const line = (id: string, at: number) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: {
      id,
      model: 'claude-opus-5-5',
      usage: { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });

const tokensIn = (entry: LedgerEntry | undefined) => entry?.buckets.reduce((sum, b) => sum + b.usage.input, 0) ?? null;

describe('createLedgerSync', () => {
  let dir: string;
  let tokens: TranscriptTokens;
  let ledger: UsageLedger;
  let workspaces: { id: string; name: string }[];
  let transcripts: Record<string, string>;
  let archived: { id: string; name: string; transcript: string }[];
  let sync: ReturnType<typeof createLedgerSync>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cw-ledger-sync-'));
    tokens = new TranscriptTokens();
    ledger = new UsageLedger(join(dir, 'usage.json'));
    workspaces = [];
    transcripts = {};
    archived = [];
    sync = createLedgerSync({ workspaces: () => workspaces, transcript: (id) => transcripts[id] ?? null, archived: () => archived, tokens, ledger });
  });

  const transcript = (name: string, messages: [id: string, at: number][]) => {
    const file = join(dir, name);
    writeFileSync(file, `${messages.map(([id, at]) => line(id, at)).join('\n')}\n`);
    return file;
  };

  it('lists the live transcripts by path, leaving out a workspace that has none', () => {
    workspaces = [
      { id: 'ws-1', name: 'acme/app' },
      { id: 'ws-2', name: 'no session' },
    ];
    transcripts['ws-1'] = '/Users/me/.claude/projects/acme/one.jsonl';
    expect([...sync.liveTranscripts()]).toEqual([['/Users/me/.claude/projects/acme/one.jsonl', { id: 'ws-1', name: 'acme/app' }]]);
  });

  it('counts a live transcript once, keeps it in the ledger after its session, and does not read it again unchanged', async () => {
    workspaces = [{ id: 'ws-1', name: 'acme/app' }];
    const file = transcript('live.jsonl', [['m1', Date.now() - hour]]);
    transcripts['ws-1'] = file;
    // Nothing is recorded until the first read has reached the end.
    sync.recordLive(file, { id: 'ws-1', name: 'acme/app' });
    expect(ledger.get(file)).toBeUndefined();
    await sync.refreshLive(file, { id: 'ws-1' });
    sync.recordLive(file, { id: 'ws-1', name: 'acme/app' });
    expect(ledger.get(file)).toMatchObject({ workspaceId: 'ws-1', name: 'acme/app' });
    expect(tokensIn(ledger.get(file))).toBe(1_000_000);

    // The session ends and its counter is dropped; the figures come from the ledger from now on.
    workspaces = [];
    tokens.keepOnly([]);
    const before = readFileSync(file);
    await sync.settle();
    expect(tokens.peek(file)).toBeNull();
    expect(tokensIn(ledger.get(file))).toBe(1_000_000);
    expect(readFileSync(file)).toEqual(before);
    expect(existsSync(join(dir, 'usage.json'))).toBe(true);
  });

  it('counts a transcript that is no longer live again once it has grown, and keeps its figures once it is gone', async () => {
    workspaces = [{ id: 'ws-1', name: 'acme/app' }];
    const file = transcript('left.jsonl', [['m1', Date.now() - 2 * hour]]);
    transcripts['ws-1'] = file;
    await sync.refreshLive(file, { id: 'ws-1' });
    sync.recordLive(file, { id: 'ws-1', name: 'acme/app' });
    workspaces = [];
    await sync.settle();
    expect(tokensIn(ledger.get(file))).toBe(1_000_000);

    // Resumed by hand after the workspace moved on: a later write means another count, of the whole file.
    appendFileSync(file, `${line('m2', Date.now() - hour)}\n`);
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    await sync.settle();
    expect(tokensIn(ledger.get(file))).toBe(2_000_000);

    rmSync(file);
    await sync.settle();
    expect(tokensIn(ledger.get(file))).toBe(2_000_000);
  });

  it("counts an archived workspace's transcript the ledger has not seen, and not one a live workspace is on", async () => {
    workspaces = [{ id: 'ws-1', name: 'acme/app' }];
    const live = transcript('live.jsonl', [['m1', Date.now() - hour]]);
    transcripts['ws-1'] = live;
    const gone = transcript('gone.jsonl', [['m2', Date.now() - hour]]);
    archived = [
      { id: 'w-gone', name: 'gone', transcript: gone },
      // Restored onto the live one's transcript: not a second count.
      { id: 'w-restored', name: 'restored', transcript: live },
    ];
    await sync.settle();
    expect(ledger.get(gone)).toMatchObject({ workspaceId: 'w-gone', name: 'gone' });
    expect(tokensIn(ledger.get(gone))).toBe(1_000_000);
    // The live one is recorded under its own workspace once its counter has read it.
    expect(ledger.get(live)).toBeUndefined();
    await sync.refreshLive(live, { id: 'ws-1' });
    await sync.settle();
    expect(ledger.get(live)).toMatchObject({ workspaceId: 'ws-1', name: 'acme/app' });
  });

  it('runs one settling pass at a time', async () => {
    const first = sync.settle();
    expect(sync.settle()).toBe(first);
    await first;
    expect(sync.settle()).not.toBe(first);
  });

  it("gives when a workspace's earlier transcript ended, and null for a file it cannot read", async () => {
    workspaces = [{ id: 'ws-1', name: 'acme/app' }];
    const endedAt = Date.now() - hour;
    const first = transcript('first.jsonl', [['m1', endedAt]]);
    transcripts['ws-1'] = first;
    await sync.refreshLive(first, { id: 'ws-1' });
    sync.recordLive(first, { id: 'ws-1', name: 'acme/app' });
    // A fork's file is created now, so the first conversation is what it may have copied.
    const fork = transcript('fork.jsonl', [['m1', endedAt]]);
    expect(sync.earlierEnded(fork, 'ws-1')).toBe(endedAt);
    expect(sync.earlierEnded(fork, 'ws-other')).toBeNull();
    expect(sync.earlierEnded(join(dir, 'missing.jsonl'), 'ws-1')).toBeNull();
  });
});

describe('the usage ledger through the service', () => {
  let h: Harness;
  let dir: string;
  beforeEach(async () => {
    h = await startHarness();
    dir = mkdtempSync(join(tmpdir(), 'cw-adm-ledger-'));
  });
  afterEach(async () => {
    await h.close();
  });
  const transcript = (name: string, messages: [id: string, at: number][]) => {
    const file = join(dir, name);
    writeFileSync(file, `${messages.map(([id, at]) => line(id, at)).join('\n')}\n`);
    return file;
  };

  async function ask(request: unknown, replyType: ControlToClient['type']) {
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify(request));
    await waitFor(() => messages.some((m) => m.type === replyType));
    const reply = messages.find((m) => m.type === replyType)!;
    return { ws, messages, reply };
  }

  /** Lets the minute timer bring the ledger up to date, then reads the usage card's figures. */
  const usage = async () => {
    await h.admin.sample();
    const { ws, reply } = await ask({ type: 'system' }, 'system');
    ws.close();
    if (reply.type !== 'system' || !reply.snapshot) throw new Error('no snapshot');
    const { daily, workspaces } = reply.snapshot.usage;
    const total = (days: { tokens: number }[]) => days.reduce((sum, d) => sum + d.tokens, 0);
    return { tokens: total(daily), workspaces: workspaces.map((w) => [w.name, total(w.daily)]) };
  };

  it("keeps an archived workspace's usage once its transcript and its place under Archived are gone", async () => {
    const gone = transcript('gone.jsonl', [['m1', Date.now() - hour]]);
    h.archived = [{ id: 'w-gone', name: 'acme/app', transcript: gone }];
    expect(await usage()).toEqual({ tokens: 1_000_000, workspaces: [['acme/app', 1_000_000]] });
    rmSync(gone);
    h.archived = [];
    expect(await usage()).toEqual({ tokens: 1_000_000, workspaces: [['acme/app', 1_000_000]] });
    expect(existsSync(join(h.dataDir, 'usage.json'))).toBe(true);
  });

  it('counts the session before a /clear under the same workspace, and a resumed transcript once', async () => {
    const workspace = h.store.create({ name: 'acme/app', cwd: h.defaultCwd });
    const before = transcript('before.jsonl', [['m1', Date.now() - 2 * hour]]);
    h.transcripts[workspace.id] = before;
    expect(await usage()).toEqual({ tokens: 1_000_000, workspaces: [['acme/app', 1_000_000]] });
    h.transcripts[workspace.id] = transcript('after.jsonl', [['m2', Date.now() - hour]]);
    expect(await usage()).toEqual({ tokens: 2_000_000, workspaces: [['acme/app', 2_000_000]] });
    // Resumed onto the first transcript again, which goes on growing.
    h.transcripts[workspace.id] = before;
    writeFileSync(before, `${readFileSync(before, 'utf8')}${readFileSync(transcript('more.jsonl', [['m3', Date.now()]]), 'utf8')}`);
    expect(await usage()).toEqual({ tokens: 3_000_000, workspaces: [['acme/app', 3_000_000]] });
  });

  it('leaves out the conversation a fork copied from the session before it', async () => {
    const workspace = h.store.create({ name: 'acme/app', cwd: h.defaultCwd });
    const copiedAt = Date.now() - hour;
    h.transcripts[workspace.id] = transcript('first.jsonl', [['m1', copiedAt]]);
    await usage();
    // The fork's file is created now, holding the earlier message with its own date, then a new one.
    h.transcripts[workspace.id] = transcript('fork.jsonl', [
      ['m1', copiedAt],
      ['m2', Date.now() + 60_000],
    ]);
    expect(await usage()).toEqual({ tokens: 2_000_000, workspaces: [['acme/app', 2_000_000]] });
  });
});
