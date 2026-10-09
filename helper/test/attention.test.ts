import { describe, expect, it } from 'vitest';
import { attentionEvents, needsInputCount } from '../../shared/attention';

describe('needsInputCount', () => {
  it('counts only the workspaces asked about that are waiting', () => {
    const statuses = { a: 'needs_input', b: 'working', c: 'needs_input', gone: 'needs_input' } as const;
    expect(needsInputCount(statuses, ['a', 'b', 'c'])).toBe(2);
    expect(needsInputCount({}, ['a'])).toBe(0);
  });
});

describe('attentionEvents', () => {
  it('reports a workspace that started waiting, and one that finished working', () => {
    const events = attentionEvents({ a: 'working', b: 'working', c: 'idle' }, { a: 'needs_input', b: 'idle', c: 'idle' });
    expect(events).toEqual([{ id: 'a', kind: 'needs_input' }, { id: 'b', kind: 'finished' }]);
  });

  it('is silent for a workspace already waiting, a first sighting, and changes that need no attention', () => {
    expect(attentionEvents({ a: 'needs_input' }, { a: 'needs_input' })).toEqual([]);
    expect(attentionEvents({}, { a: 'needs_input' })).toEqual([]);
    expect(attentionEvents({ a: 'idle' }, { a: 'working' })).toEqual([]);
    expect(attentionEvents({ a: 'needs_input' }, { a: 'idle' })).toEqual([]);
    expect(attentionEvents({ a: null }, { a: 'idle' })).toEqual([]);
  });
});
