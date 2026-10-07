import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMcStatus } from '../src/mc-status';

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
    expect(readMcStatus(dir).get('ws-1')).toEqual({ status: 'needs_input', claudeSessionId: ID_NEW, browserAt: null });
  });

  it('reports no live status for ended sessions but keeps their id for resuming', () => {
    const dir = stateDir({ 'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'ended', started_at: '2026-01-01T00:00:00Z' } });
    expect(readMcStatus(dir).get('ws-1')).toEqual({ status: null, claudeSessionId: ID_OLD, browserAt: null });
  });

  it('reports when the session last used Claude in Chrome', () => {
    const dir = stateDir({
      'a.json': { session_id: ID_OLD, cw_workspace_id: 'ws-1', status: 'working', started_at: '2026-01-01T00:00:00Z', browser_at: '2026-01-01T00:05:00.000Z' },
    });
    expect(readMcStatus(dir).get('ws-1')?.browserAt).toBe(Date.parse('2026-01-01T00:05:00.000Z'));
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
