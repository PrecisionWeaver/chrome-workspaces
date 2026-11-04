import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UsageBucket } from '../src/tokens';
import { type LedgerEntry, UsageLedger } from '../src/usage-ledger';

const file = () => join(mkdtempSync(join(tmpdir(), 'cw-ledger-')), 'usage.json');
const bucket = (day: string, hour: number | null, input: number, model = 'claude-opus-5-5'): UsageBucket => ({
  model,
  day,
  hour,
  usage: { input, output: 0, cacheWrite: 0, cacheRead: 0 },
});
const entry = (transcript: string, buckets: UsageBucket[], extra: Partial<LedgerEntry> = {}): LedgerEntry => ({
  transcript,
  workspaceId: 'w-1',
  name: 'acme/app',
  createdMs: 1,
  mtimeMs: 1,
  lastAt: null,
  buckets,
  ...extra,
});

describe('UsageLedger', () => {
  it('replaces what a transcript used rather than adding to it, and keeps it across a restart', () => {
    const path = file();
    const ledger = new UsageLedger(path);
    ledger.record(entry('/t/a.jsonl', [bucket('2026-10-08', 10, 5)]));
    ledger.record(entry('/t/a.jsonl', [bucket('2026-10-08', 10, 7)], { mtimeMs: 2 }));
    ledger.save();
    expect(new UsageLedger(path).list()).toEqual([entry('/t/a.jsonl', [bucket('2026-10-08', 10, 7)], { mtimeMs: 2 })]);
  });

  it('does not write when nothing changed, and leaves out undated usage', () => {
    const path = file();
    const ledger = new UsageLedger(path);
    ledger.save();
    expect(existsSync(path)).toBe(false);
    ledger.record(entry('/t/a.jsonl', [bucket('2026-10-08', 10, 5), bucket('', null, 9)]));
    ledger.save();
    writeFileSync(path, 'left alone');
    ledger.record(entry('/t/a.jsonl', [bucket('2026-10-08', 10, 5)]));
    ledger.save();
    expect(readFileSync(path, 'utf8')).toBe('left alone');
    expect(ledger.get('/t/a.jsonl')?.buckets).toEqual([bucket('2026-10-08', 10, 5)]);
  });

  it('drops days before the oldest kept, folds earlier days into one figure per model, and keeps today by hour', () => {
    const ledger = new UsageLedger(file());
    ledger.record(
      entry('/t/a.jsonl', [
        bucket('2026-08-01', 9, 100),
        bucket('2026-10-07', 9, 1),
        bucket('2026-10-07', 15, 2),
        bucket('2026-10-07', 15, 4, 'claude-sonnet-4'),
        bucket('2026-10-08', 9, 8),
        bucket('2026-10-08', 10, 16),
      ]),
    );
    ledger.record(entry('/t/old.jsonl', [bucket('2026-08-01', 9, 100)]));
    ledger.prune('2026-08-10', '2026-10-08');
    expect(ledger.get('/t/a.jsonl')?.buckets).toEqual([
      bucket('2026-10-07', null, 3),
      bucket('2026-10-07', null, 4, 'claude-sonnet-4'),
      bucket('2026-10-08', 9, 8),
      bucket('2026-10-08', 10, 16),
    ]);
    expect(ledger.get('/t/old.jsonl')).toBeUndefined();
  });

  it("gives when a workspace's transcripts created earlier last wrote, never a newer one's", () => {
    const ledger = new UsageLedger(file());
    ledger.record(entry('/t/a.jsonl', [], { createdMs: 10, lastAt: 100 }));
    ledger.record(entry('/t/b.jsonl', [], { createdMs: 200, lastAt: 300 }));
    ledger.record(entry('/t/c.jsonl', [], { createdMs: 10, lastAt: 900, workspaceId: 'w-2' }));
    expect(ledger.earlierEnded('w-1', 500)).toBe(300);
    // `a` resumed after `b` was made: `b` cannot be what it copied.
    expect(ledger.earlierEnded('w-1', 10)).toBeNull();
    expect(ledger.earlierEnded('w-1', 200)).toBe(100);
    expect(ledger.earlierEnded('w-3', 500)).toBeNull();
  });

  it('starts empty from a damaged file', () => {
    const path = file();
    writeFileSync(path, '{ not json');
    expect(new UsageLedger(path).list()).toEqual([]);
  });
});
