import { describe, expect, it } from 'vitest';
import { CALL_WINDOW_MS, groupOwner } from '../../shared/claude-groups';

const SEEN = 1_000_000;

describe('groupOwner', () => {
  it('gives the group to the workspace whose call finished after it appeared', () => {
    expect(groupOwner(SEEN, [{ workspaceId: 'a', at: SEEN + 300 }])).toBe('a');
  });

  it('prefers the first call to finish after the group appeared', () => {
    const calls = [
      { workspaceId: 'late', at: SEEN + 4_000 },
      { workspaceId: 'first', at: SEEN + 800 },
      { workspaceId: 'earlier', at: SEEN - 5_000 },
    ];
    expect(groupOwner(SEEN, calls)).toBe('first');
  });

  it('ignores calls that finished before the group appeared, or long after', () => {
    expect(groupOwner(SEEN, [{ workspaceId: 'a', at: SEEN - 5_000 }])).toBeNull();
    expect(groupOwner(SEEN, [{ workspaceId: 'a', at: SEEN + CALL_WINDOW_MS + 1 }])).toBeNull();
  });

  it('allows for the group event arriving just after the call was stamped', () => {
    expect(groupOwner(SEEN, [{ workspaceId: 'a', at: SEEN - 200 }])).toBe('a');
  });
});
