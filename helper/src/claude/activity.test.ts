import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '../../../shared/sessions/activity';
import { readActivity } from './activity';

const T0 = Date.parse('2026-03-10T12:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const ev = (seconds: number, event: ActivityEvent['event'], rest: Partial<ActivityEvent> = {}): ActivityEvent => ({ at: at(seconds), event, ...rest });

describe('readActivity', () => {
  it('folds the lines at the end of an events file, and is empty for a file that is not there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-activity-'));
    const file = join(dir, 's.events.jsonl');
    const lines = [ev(0, 'UserPromptSubmit', { promptId: 'p1', summary: 'hi' }), ev(1, 'Stop', { promptId: 'p1' })].map((e) => JSON.stringify(e));
    writeFileSync(file, `${lines.join('\n')}\n`);
    expect(readActivity(file)).toEqual([expect.objectContaining({ prompt: 'hi', endedAt: at(1) })]);
    expect(readActivity(join(dir, 'missing.jsonl'))).toEqual([]);
  });

  it('reads only the tail of a long file, dropping the line it starts in the middle of', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-activity-'));
    const file = join(dir, 's.events.jsonl');
    const line = (n: number) => JSON.stringify(ev(n, 'UserPromptSubmit', { promptId: `p${n}`, summary: `prompt ${n} ${'x'.repeat(200)}` }));
    writeFileSync(file, `${Array.from({ length: 5000 }, (_, n) => line(n)).join('\n')}\n`);
    const items = readActivity(file, 3);
    expect(items.map((i) => i.kind === 'turn' && i.id)).toEqual(['p4997', 'p4998', 'p4999']);
  });
});
