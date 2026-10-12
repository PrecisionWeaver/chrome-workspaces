import { describe, expect, it } from 'vitest';
import { describeTool, eventsFromLine } from '../../shared/timeline';

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-08T10:00:00Z', message: { role: 'assistant', content }, ...extra });
const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', timestamp: '2026-10-08T10:00:05Z', message: { role: 'user', content }, ...extra });

describe('describeTool', () => {
  it('names the file for file tools, the description for a command, and the target for a search', () => {
    expect(describeTool('Edit', { file_path: '/repo/a.ts', old_string: 'x' })).toEqual({ summary: '/repo/a.ts', file: '/repo/a.ts' });
    expect(describeTool('Bash', { command: 'sed -n 1,5p x', description: 'Show the top of x' })).toEqual({ summary: 'Show the top of x' });
    expect(describeTool('Bash', { command: 'git status\n  --short' })).toEqual({ summary: 'git status --short' });
    expect(describeTool('Grep', { pattern: 'TODO', path: 'src' }).summary).toBe('TODO in src');
    expect(describeTool('WebFetch', { url: 'https://x.example' }).summary).toBe('https://x.example');
    expect(describeTool('Agent', { description: 'Review the diff', prompt: 'long…' }).summary).toBe('Review the diff');
    expect(describeTool('Mystery', {}).summary).toBe('');
  });

  it('cuts a long summary to one line', () => {
    expect(describeTool('Bash', { command: 'x'.repeat(500) }).summary).toHaveLength(160);
  });
});

describe('eventsFromLine', () => {
  it('turns an assistant message into what it said and each tool it called, with the time', () => {
    const events = eventsFromLine(
      assistant([
        { type: 'text', text: 'Looking at it.' },
        { type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.ts' } },
        { type: 'tool_use', name: 'Bash', input: { command: 'ls', description: 'List files' } },
      ]),
    );
    expect(events).toEqual([
      { at: '2026-10-08T10:00:00Z', kind: 'said', tool: '', summary: 'Looking at it.' },
      { at: '2026-10-08T10:00:00Z', kind: 'tool', tool: 'Read', summary: '/repo/a.ts', file: '/repo/a.ts' },
      { at: '2026-10-08T10:00:00Z', kind: 'tool', tool: 'Bash', summary: 'List files' },
    ]);
  });

  it('reads what you typed, and ignores tool results, command plumbing and sub-agent chatter', () => {
    expect(eventsFromLine(user('commit and push'))).toEqual([{ at: '2026-10-08T10:00:05Z', kind: 'you', tool: '', summary: 'commit and push' }]);
    expect(eventsFromLine(user([{ type: 'text', text: 'with a block' }]))[0]).toMatchObject({ kind: 'you', summary: 'with a block' });
    expect(eventsFromLine(user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]))).toEqual([]);
    expect(eventsFromLine(user('<command-name>/compact</command-name>'))).toEqual([]);
    expect(eventsFromLine(assistant([{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }], { isSidechain: true }))).toEqual([]);
  });

  it('ignores lines that are not messages, are cut off, or have no content', () => {
    expect(eventsFromLine(JSON.stringify({ type: 'attachment' }))).toEqual([]);
    expect(eventsFromLine('{"message": {"role": "user", "content": "cut')).toEqual([]);
    expect(eventsFromLine(assistant([{ type: 'thinking', thinking: 'hm' }]))).toEqual([]);
    expect(eventsFromLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'no time' }] } }))[0]).toMatchObject({
      at: '',
      summary: 'no time',
    });
  });
});
