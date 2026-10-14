import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importLegacySessions, lastTranscriptCwd, pruneSessions, readSessionStatus } from '../src/session-status';
import { existsSync, readdirSync, utimesSync } from 'node:fs';

function stateDir(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'cw-sessions-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const ID_OLD = '11111111-1111-1111-1111-111111111111';
const ID_NEW = '22222222-2222-2222-2222-222222222222';

describe('readSessionStatus', () => {
  it('uses the most recently started session per workspace', () => {
    const dir = stateDir({
      'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'idle', started_at: '2026-01-01T00:00:00Z' },
      'b.json': { session_id: ID_NEW, cw_workspace_id: 'ws-1', status: 'needs_input', started_at: '2026-01-02T00:00:00Z' },
    });
    expect(readSessionStatus(dir).get('ws-1')).toEqual({ status: 'needs_input', claudeSessionId: ID_NEW, browserAt: null, cwd: null, transcriptPath: null });
  });

  it('reports no live status for ended sessions but keeps their id for resuming', () => {
    const dir = stateDir({ 'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'ended', started_at: '2026-01-01T00:00:00Z' } });
    expect(readSessionStatus(dir).get('ws-1')).toEqual({ status: null, claudeSessionId: ID_OLD, browserAt: null, cwd: null, transcriptPath: null });
  });

  it('reports when the session last used Claude in Chrome', () => {
    const dir = stateDir({
      'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'working', started_at: '2026-01-01T00:00:00Z', browser_at: '2026-01-01T00:05:00.000Z' },
    });
    expect(readSessionStatus(dir).get('ws-1')?.browserAt).toBe(Date.parse('2026-01-01T00:05:00.000Z'));
  });

  it('reports the directory the session is working in', () => {
    const dir = stateDir({
      'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'working', started_at: '2026-01-01T00:00:00Z', cwd: '/repo/.worktrees/topic' },
    });
    expect(readSessionStatus(dir).get('ws-1')?.cwd).toBe('/repo/.worktrees/topic');
  });

  it('skips sessions that are not in a workspace, and unreadable files', () => {
    const dir = stateDir({
      'a.json': { session_id: ID_OLD, status: 'working', started_at: '2026-01-01T00:00:00Z' },
      'b.json': '{ broken',
      'notes.txt': 'ignored',
    });
    expect(readSessionStatus(dir).size).toBe(0);
  });

  it('returns nothing when there is no sessions folder', () => {
    expect(readSessionStatus(join(tmpdir(), 'cw-sessions-does-not-exist')).size).toBe(0);
  });

  it("ignores a newer session started outside the workspace's directory, e.g. one that inherited its id", () => {
    const dir = stateDir({
      'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'ended', started_at: '2026-01-01T00:00:00Z', cwd: '/acme/app' },
      'b.json': { session_id: ID_NEW, cw_workspace_id: 'ws-1', status: 'working', started_at: '2026-01-02T00:00:00Z', cwd: '/acme/other' },
    });
    expect(readSessionStatus(dir, new Map([['ws-1', '/acme/app']])).get('ws-1')?.claudeSessionId).toBe(ID_OLD);
  });

  it('keeps a session started in a worktree inside the workspace directory', () => {
    const dir = stateDir({
      'a.json': { session_id: ID_NEW, cw_workspace_id: 'ws-1', status: 'idle', started_at: '2026-01-02T00:00:00Z', cwd: '/acme/app/.worktrees/topic' },
    });
    expect(readSessionStatus(dir, new Map([['ws-1', '/acme/app']])).get('ws-1')?.claudeSessionId).toBe(ID_NEW);
    // A sibling directory that merely shares the prefix is not inside it.
    const sibling = stateDir({
      'a.json': { session_id: ID_NEW, cw_workspace_id: 'ws-1', status: 'idle', started_at: '2026-01-02T00:00:00Z', cwd: '/acme/app-two' },
    });
    expect(readSessionStatus(sibling, new Map([['ws-1', '/acme/app']])).has('ws-1')).toBe(false);
  });

  it('does not let an ended session that never recorded a message hide the conversation before it', () => {
    const empty = join(tmpdir(), 'cw-no-such-transcript.jsonl');
    const dir = stateDir({
      'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'ended', started_at: '2026-01-01T00:00:00Z' },
      'b.json': { session_id: ID_NEW, cw_workspace_id: 'ws-1', status: 'ended', started_at: '2026-01-02T00:00:00Z', transcript_path: empty },
    });
    expect(readSessionStatus(dir).get('ws-1')?.claudeSessionId).toBe(ID_OLD);
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

describe('pruneSessions', () => {
  it('deletes state files untouched for a month, and keeps recent ones and other files', () => {
    const dir = stateDir({ 'old.json': { session_id: ID_OLD }, 'new.json': { session_id: ID_NEW }, 'notes.txt': 'keep' });
    const old = Date.now() / 1000 - 31 * 24 * 60 * 60;
    for (const name of ['old.json', 'notes.txt']) utimesSync(join(dir, name), old, old);
    pruneSessions(dir);
    expect([existsSync(join(dir, 'old.json')), existsSync(join(dir, 'new.json')), existsSync(join(dir, 'notes.txt'))]).toEqual([false, true, true]);
  });

  it('does nothing for a folder that does not exist', () => {
    expect(() => pruneSessions(join(tmpdir(), 'cw-sessions-does-not-exist'))).not.toThrow();
  });
});

describe('importLegacySessions', () => {
  it('brings over workspace sessions as ended, so they resume, and leaves the rest', () => {
    const transcript = join(stateDir({ 't.jsonl': '{}' }), 't.jsonl');
    const legacy = stateDir({
      'a.json': {
        session_id: ID_OLD,
        cw_workspace_id: 'ws-1',
        status: 'working',
        started_at: '2026-01-01T00:00:00Z',
        cwd: '/repo',
        transcript_path: transcript,
        pid: 5,
      },
      'plain.json': { session_id: ID_NEW, status: 'idle' },
      'unsafe.json': { session_id: '../x', cw_workspace_id: 'ws-2' },
      'notes.txt': 'x',
    });
    const dir = stateDir({});
    expect(importLegacySessions(legacy, dir)).toBe(1);
    expect(readSessionStatus(dir).get('ws-1')).toEqual({ status: null, claudeSessionId: ID_OLD, browserAt: null, cwd: '/repo', transcriptPath: transcript });
    expect(readdirSync(dir)).toEqual(['a.json']);
  });

  it('keeps a session the app already recorded, skips old ones, and copes with no legacy folder', () => {
    const legacy = stateDir({ 'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1' }, 'stale.json': { session_id: ID_NEW, cw_workspace_id: 'ws-2' } });
    const old = Date.now() / 1000 - 31 * 24 * 60 * 60;
    utimesSync(join(legacy, 'stale.json'), old, old);
    const dir = stateDir({ 'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'working' } });
    expect(importLegacySessions(legacy, dir)).toBe(0);
    expect(readSessionStatus(dir).get('ws-1')?.status).toBe('working');
    expect(importLegacySessions(join(tmpdir(), 'cw-sessions-does-not-exist'), dir)).toBe(0);
  });
});
