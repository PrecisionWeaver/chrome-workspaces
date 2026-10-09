import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TranscriptTokens, usageFromLine } from '../src/tokens';

const line = (id: string, usage: Record<string, number>, extra: Record<string, unknown> = {}, model = 'claude-opus-5-5') => JSON.stringify({ type: 'assistant', message: { id, usage, model }, ...extra });
const use = (input: number, output: number, write = 0, read = 0) => ({ input_tokens: input, output_tokens: output, cache_creation_input_tokens: write, cache_read_input_tokens: read });
const transcript = (lines: string[]) => {
  const file = join(mkdtempSync(join(tmpdir(), 'cw-tok-')), 't.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
};

describe('usageFromLine', () => {
  it('reads the four figures and the message id, and ignores lines without usage', () => {
    expect(usageFromLine(line('m1', use(2, 482, 64033, 26853), { timestamp: '2026-10-08T14:22:01.000Z' }))).toEqual({ id: 'm1', usage: { input: 2, output: 482, cacheWrite: 64033, cacheRead: 26853 }, model: 'claude-opus-5-5', day: '2026-10-08' });
    expect(usageFromLine(line('m2', use(1, 1), { timestamp: 'garbage' }))).toMatchObject({ day: '' });
    expect(usageFromLine(JSON.stringify({ type: 'user', message: { content: 'hi' } }))).toBeNull();
    expect(usageFromLine('{"usage": cut off')).toBeNull();
    expect(usageFromLine(JSON.stringify({ message: { usage: use(1, 1) } }))).toBeNull();
  });

  it('treats a missing or non-numeric figure as zero', () => {
    expect(usageFromLine(line('m', { input_tokens: 5, output_tokens: 'x' as unknown as number }))?.usage).toEqual({ input: 5, output: 0, cacheWrite: 0, cacheRead: 0 });
  });
});

describe('TranscriptTokens buckets', () => {
  it('groups usage by model and day, counting a repeated message once and keeping its model and day', async () => {
    const tokens = new TranscriptTokens();
    const file = transcript([
      line('a', use(1, 10), { timestamp: '2026-10-07T23:59:00Z' }),
      line('a', use(1, 10), { timestamp: '2026-10-07T23:59:01Z' }),
      line('b', use(2, 20), { timestamp: '2026-10-08T00:01:00Z' }),
      line('c', use(4, 40), { timestamp: '2026-10-08T09:00:00Z' }, 'claude-sonnet-4'),
    ]);
    await tokens.refresh(file);
    const buckets = tokens.peek(file)!.buckets.map((b) => [b.model, b.day, b.usage.input, b.usage.output]).sort();
    expect(buckets).toEqual([
      ['claude-opus-5-5', '2026-10-07', 1, 10],
      ['claude-opus-5-5', '2026-10-08', 2, 20],
      ['claude-sonnet-4', '2026-10-08', 4, 40],
    ]);
  });
});

describe('TranscriptTokens', () => {
  it('counts each message once, however many times claude wrote it', async () => {
    const tokens = new TranscriptTokens();
    const file = transcript([line('a', use(2, 100, 1000, 500)), line('a', use(2, 100, 1000, 500)), line('a', use(2, 100, 1000, 500)), line('b', use(10, 20, 0, 800)), JSON.stringify({ type: 'user' })]);
    await tokens.refresh(file);
    expect(tokens.peek(file)).toMatchObject({ totals: { input: 12, output: 120, cacheWrite: 1000, cacheRead: 1300 }, scanning: false });
  });

  it('uses the largest figures of a message that grew while streaming', async () => {
    const tokens = new TranscriptTokens();
    const file = transcript([line('a', use(2, 10)), line('a', use(2, 90)), line('a', use(2, 40))]);
    await tokens.refresh(file);
    expect(tokens.peek(file)?.totals.output).toBe(90);
  });

  it('reads only what was appended, and waits for a line that is not finished', async () => {
    const tokens = new TranscriptTokens();
    const file = transcript([line('a', use(1, 10))]);
    await tokens.refresh(file);
    appendFileSync(file, line('b', use(1, 20)).slice(0, 30));
    await tokens.refresh(file);
    expect(tokens.peek(file)?.totals.output).toBe(10);
    appendFileSync(file, line('b', use(1, 20)).slice(30) + '\n');
    await tokens.refresh(file);
    expect(tokens.peek(file)?.totals).toMatchObject({ input: 2, output: 30 });
  });

  it('gives the same answer reading in tiny chunks, including across multibyte characters', async () => {
    const file = transcript(Array.from({ length: 30 }, (_, i) => line(`m${i}`, use(1, i, 0, 7), { note: 'héllo wörld ✓ 日本語'.repeat(5) })));
    const whole = new TranscriptTokens();
    const tiny = new TranscriptTokens(64);
    await Promise.all([whole.refresh(file), tiny.refresh(file)]);
    expect(tiny.peek(file)?.totals).toEqual(whole.peek(file)?.totals);
    expect(whole.peek(file)?.totals).toMatchObject({ input: 30, output: (29 * 30) / 2, cacheRead: 210 });
  });

  it('starts over when the file is rewritten shorter, and survives a missing file', async () => {
    const tokens = new TranscriptTokens();
    const file = transcript([line('a', use(1, 500)), line('b', use(1, 500))]);
    await tokens.refresh(file);
    writeFileSync(file, line('c', use(1, 7)) + '\n');
    await tokens.refresh(file);
    expect(tokens.peek(file)?.totals.output).toBe(7);
    const missing = join(tmpdir(), 'cw-no-such-transcript.jsonl');
    await expect(tokens.refresh(missing)).resolves.toBeUndefined();
    // Nothing to show, rather than a zero that reads as an empty session.
    expect(tokens.peek(missing)).toBeNull();
    expect(tokens.peek('never asked')).toBeNull();
  });

  it('shares one scan between callers, and forgets paths no longer asked about', async () => {
    const tokens = new TranscriptTokens();
    const file = transcript([line('a', use(1, 1))]);
    const first = tokens.refresh(file);
    expect(tokens.peek(file)?.scanning).toBe(true);
    expect(tokens.refresh(file)).toBe(first);
    await first;
    tokens.keepOnly([]);
    expect(tokens.peek(file)).toBeNull();
  });
});
