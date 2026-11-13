import { describe, expect, it } from 'vitest';
import { attentionEvents, describeWaiting, needsInputCount, statusLabel } from './attention';

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
    expect(events).toEqual([
      { id: 'a', kind: 'needs_input' },
      { id: 'b', kind: 'finished' },
    ]);
  });

  it('is silent for a workspace already waiting, a first sighting, and changes that need no attention', () => {
    expect(attentionEvents({ a: 'needs_input' }, { a: 'needs_input' })).toEqual([]);
    expect(attentionEvents({}, { a: 'needs_input' })).toEqual([]);
    expect(attentionEvents({ a: 'idle' }, { a: 'working' })).toEqual([]);
    expect(attentionEvents({ a: 'needs_input' }, { a: 'idle' })).toEqual([]);
    expect(attentionEvents({ a: null }, { a: 'idle' })).toEqual([]);
  });
});

describe('describeWaiting', () => {
  it("tells a permission prompt from a question, in claude's words when it gave any", () => {
    expect(describeWaiting('acme/app', { type: 'permission_prompt', message: 'Claude needs your permission to use Bash' })).toEqual({
      kind: 'permission',
      title: 'acme/app needs your permission',
      message: 'Claude needs your permission to use Bash',
    });
    expect(describeWaiting('acme/app', { type: 'idle_prompt', message: 'Claude is waiting for your input' })).toEqual({
      kind: 'question',
      title: 'acme/app needs your input',
      message: 'Claude is waiting for your input',
    });
    expect(describeWaiting('acme/app', { type: 'elicitation_dialog', message: '' })).toEqual({
      kind: 'question',
      title: 'acme/app needs your input',
      message: 'Claude is waiting for you.',
    });
    expect(describeWaiting('acme/app', undefined)).toEqual({ kind: 'question', title: 'acme/app needs your input', message: 'Claude is waiting for you.' });
  });
});

describe('statusLabel', () => {
  it('names a status in a word or two, telling a permission prompt from other waits', () => {
    expect(statusLabel('working', undefined)).toBe('working');
    expect(statusLabel('idle', undefined)).toBe('idle');
    expect(statusLabel('needs_input', undefined)).toBe('needs input');
    expect(statusLabel('needs_input', { type: 'idle_prompt', message: '' })).toBe('needs input');
    expect(statusLabel('needs_input', { type: 'permission_prompt', message: '' })).toBe('needs permission');
    expect(statusLabel(null, undefined)).toBe('');
  });
});
