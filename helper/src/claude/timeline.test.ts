import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readTimeline } from './timeline';

const said = (n: number) =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-08T10:00:00Z', message: { role: 'assistant', content: [{ type: 'text', text: `reply ${n}` }] } });

describe('readTimeline', () => {
  it('reads the newest events of a transcript, oldest first, and is empty for a file that is not there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-timeline-'));
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, `${[1, 2, 3, 4].map(said).join('\n')}\n`);
    expect(readTimeline(file).map((event) => event.summary)).toEqual(['reply 1', 'reply 2', 'reply 3', 'reply 4']);
    expect(readTimeline(file, 2).map((event) => event.summary)).toEqual(['reply 3', 'reply 4']);
    expect(readTimeline(join(dir, 'missing.jsonl'))).toEqual([]);
  });
});
