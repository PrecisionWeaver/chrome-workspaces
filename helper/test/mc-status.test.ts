import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastTranscriptCwd, readMcStatus } from '../src/mc-status';

function stateDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-mc-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const ID_OLD = '11111111-1111-1111-1111-111111111111';
const ID_NEW = '22222222-2222-2222-2222-222222222222';

describe('readMcStatus', () => {
  it('uses the most recently started session per workspace', () => {
    const dir = stateDir({
      'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'idle', started_at: '2026-01-01T00:00:00Z' },
      'b.json': { session_id: ID_NEW, cw_workspace_id: 'ws-1', status: 'needs_input', started_at: '2026-01-02T00:00:00Z' },
    });
    expect(readMcStatus(dir).get('ws-1')).toEqual({ status: 'needs_input', claudeSessionId: ID_NEW, browserAt: null, cwd: null, transcriptPath: null });
  });

  it('reports no live status for ended sessions but keeps their id for resuming', () => {
    const dir = stateDir({ 'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'ended', started_at: '2026-01-01T00:00:00Z' } });
    expect(readMcStatus(dir).get('ws-1')).toEqual({ status: null, claudeSessionId: ID_OLD, browserAt: null, cwd: null, transcriptPath: null });
  });

  it('reports when the session last used Claude in Chrome', () => {
    const dir = stateDir({
      'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'working', started_at: '2026-01-01T00:00:00Z', browser_at: '2026-01-01T00:05:00.000Z' },
    });
    expect(readMcStatus(dir).get('ws-1')?.browserAt).toBe(Date.parse('2026-01-01T00:05:00.000Z'));
  });

  it('reports the directory the session is working in', () => {
    const dir = stateDir({
      'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'working', started_at: '2026-01-01T00:00:00Z', cwd: '/repo/.worktrees/topic' },
    });
    expect(readMcStatus(dir).get('ws-1')?.cwd).toBe('/repo/.worktrees/topic');
  });

  it('skips sessions that are not in a workspace, and unreadable files', () => {
    const dir = stateDir({
      'a.json': { session_id: ID_OLD, status: 'working', started_at: '2026-01-01T00:00:00Z' },
      'b.json': '{ broken',
      'notes.txt': 'ignored',
    });
    expect(readMcStatus(dir).size).toBe(0);
  });

  it('returns nothing when Mission Control is not installed', () => {
    expect(readMcStatus(join(tmpdir(), 'cw-mc-does-not-exist')).size).toBe(0);
  });
});

describe('lastTranscriptCwd', () => {
  const transcript = (lines: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-transcript-'));
    const file = join(dir, 't.jsonl');
    writeFileSync(file, lines.join('\n'));
    return file;
  };

  it('returns the directory of the newest message that has one', () => {
    const file = transcript([
      JSON.stringify({ type: 'user', cwd: '/repo' }),
      JSON.stringify({ type: 'assistant', cwd: '/repo/.worktrees/topic' }),
      JSON.stringify({ type: 'summary' }),
      '',
    ]);
    expect(lastTranscriptCwd(file)).toBe('/repo/.worktrees/topic');
  });

  it('skips a line cut off mid-write, and a file with no directory', () => {
    expect(lastTranscriptCwd(transcript([JSON.stringify({ cwd: '/a' }), '{"cwd": "/b']))).toBe('/a');
    expect(lastTranscriptCwd(transcript([JSON.stringify({ type: 'user' })]))).toBeNull();
    expect(lastTranscriptCwd('/no/such/file.jsonl')).toBeNull();
  });

  it('reads only the end of a large file, ignoring the partial line it starts in', () => {
    const filler = JSON.stringify({ cwd: '/old', pad: 'x'.repeat(2000) });
    const lines = Array.from({ length: 400 }, () => filler);
    lines.push(JSON.stringify({ cwd: '/new' }));
    expect(lastTranscriptCwd(transcript(lines))).toBe('/new');
    // Nothing in the last 256 KB but filler without a directory, so the old one is out of reach.
    const bare = JSON.stringify({ pad: 'x'.repeat(2000) });
    expect(lastTranscriptCwd(transcript([JSON.stringify({ cwd: '/old' }), ...Array.from({ length: 300 }, () => bare)]))).toBeNull();
  });
});
