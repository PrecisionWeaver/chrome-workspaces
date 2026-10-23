import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type ActivityEvent, type ActivityTurn, buildActivity, parseActivityLine } from '../../shared/activity';
import { readActivity } from '../src/activity';

const T0 = Date.parse('2026-03-10T12:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const ev = (seconds: number, event: ActivityEvent['event'], rest: Partial<ActivityEvent> = {}): ActivityEvent => ({ at: at(seconds), event, ...rest });

const turns = (items: ReturnType<typeof buildActivity>) => items.filter((i): i is ActivityTurn => i.kind === 'turn');

describe('buildActivity', () => {
  it('groups a prompt, its tool calls and its Stop into one turn, tallied by tool', () => {
    const items = buildActivity([
      ev(0, 'UserPromptSubmit', { promptId: 'p1', summary: 'fix the bug' }),
      ev(1, 'PreToolUse', { promptId: 'p1', tool: 'Read', toolUseId: 'u1', summary: '/repo/a.ts', file: '/repo/a.ts' }),
      ev(2, 'PostToolUse', { promptId: 'p1', tool: 'Read', toolUseId: 'u1' }),
      ev(3, 'PreToolUse', { promptId: 'p1', tool: 'Bash', toolUseId: 'u2', summary: 'Run tests' }),
      ev(4, 'PostToolUseFailure', { promptId: 'p1', tool: 'Bash', toolUseId: 'u2' }),
      ev(5, 'PreToolUse', { promptId: 'p1', tool: 'Bash', toolUseId: 'u3', summary: 'Run tests again' }),
      ev(6, 'PostToolUse', { promptId: 'p1', tool: 'Bash', toolUseId: 'u3' }),
      ev(7, 'Stop', { promptId: 'p1' }),
    ]);
    expect(items).toEqual([
      {
        kind: 'turn',
        id: 'p1',
        prompt: 'fix the bug',
        startedAt: at(0),
        endedAt: at(7),
        skills: [],
        agents: [],
        tools: [
          { tool: 'Read', count: 1, failed: 0 },
          { tool: 'Bash', count: 2, failed: 1 },
        ],
        calls: [
          { id: 'u1', tool: 'Read', summary: '/repo/a.ts', at: at(1), endedAt: at(2), failed: false },
          { id: 'u2', tool: 'Bash', summary: 'Run tests', at: at(3), endedAt: at(4), failed: true },
          { id: 'u3', tool: 'Bash', summary: 'Run tests again', at: at(5), endedAt: at(6), failed: false },
        ],
        active: null,
      },
    ]);
  });

  it('shows the tool call under way until it returns, and a turn as running until Stop', () => {
    const events = [
      ev(0, 'UserPromptSubmit', { promptId: 'p1', summary: 'go' }),
      ev(1, 'PreToolUse', { promptId: 'p1', tool: 'Bash', toolUseId: 'u1', summary: 'Build' }),
    ];
    const [running] = turns(buildActivity(events));
    expect(running.endedAt).toBeNull();
    expect(running.active).toEqual({ tool: 'Bash', summary: 'Build', at: at(1) });
    const [returned] = turns(buildActivity([...events, ev(2, 'PostToolUse', { promptId: 'p1', tool: 'Bash', toolUseId: 'u1' })]));
    expect(returned.active).toBeNull();
    expect(returned.endedAt).toBeNull();
  });

  it('starts a subagent at its Agent call, nests the tools it runs by type, and ends it when the call returns', () => {
    const events = [
      ev(0, 'UserPromptSubmit', { promptId: 'p1', summary: 'review this' }),
      ev(1, 'PreToolUse', { promptId: 'p1', tool: 'Skill', toolUseId: 'u1', summary: 'pest' }),
      ev(1, 'PostToolUse', { promptId: 'p1', tool: 'Skill', toolUseId: 'u1' }),
      ev(2, 'PreToolUse', { promptId: 'p1', tool: 'Agent', toolUseId: 'u2', summary: 'Find the flaky test', subagentType: 'Explore' }),
      ev(4, 'PreToolUse', { promptId: 'p1', agentType: 'Explore', tool: 'Grep', toolUseId: 'u3', summary: 'flaky' }),
      ev(5, 'PostToolUse', { promptId: 'p1', agentType: 'Explore', tool: 'Grep', toolUseId: 'u3' }),
      ev(6, 'PreToolUse', { promptId: 'p1', agentType: 'Explore', tool: 'Read', toolUseId: 'u4', summary: '/repo/t.ts' }),
    ];
    const [running] = turns(buildActivity(events));
    expect(running.skills).toEqual([{ name: 'pest', at: at(1) }]);
    // The Agent call is the agent, not one of claude's own tools.
    expect(running.tools).toEqual([]);
    expect(running.agents).toEqual([
      {
        id: 'u2',
        type: 'Explore',
        summary: 'Find the flaky test',
        startedAt: at(2),
        endedAt: null,
        tools: [
          { tool: 'Grep', count: 1, failed: 0 },
          { tool: 'Read', count: 1, failed: 0 },
        ],
        calls: [
          { id: 'u3', tool: 'Grep', summary: 'flaky', at: at(4), endedAt: at(5), failed: false },
          { id: 'u4', tool: 'Read', summary: '/repo/t.ts', at: at(6), endedAt: null, failed: false },
        ],
        active: { tool: 'Read', summary: '/repo/t.ts', at: at(6) },
      },
    ]);
    const [done] = turns(buildActivity([...events, ev(8, 'PostToolUse', { promptId: 'p1', tool: 'Agent', toolUseId: 'u2' })]));
    expect(done.agents[0]).toMatchObject({ endedAt: at(8), active: null });
    // Ending the agent ends the call it still had running.
    expect(done.agents[0].calls.map((c) => c.endedAt)).toEqual([at(5), at(8)]);
    expect(done.endedAt).toBeNull();
  });

  it('keeps agents of different types apart, puts a call under the newest running one of its type, and names an agent seen only through its tools', () => {
    const [turn] = turns(
      buildActivity([
        ev(0, 'UserPromptSubmit', { promptId: 'p1', summary: 'go' }),
        ev(1, 'PreToolUse', { promptId: 'p1', tool: 'Agent', toolUseId: 'u1', summary: 'Review the diff', subagentType: 'reviewer' }),
        ev(1, 'PreToolUse', { promptId: 'p1', tool: 'Agent', toolUseId: 'u2', summary: 'Check the tests', subagentType: 'test-engineer' }),
        ev(2, 'PreToolUse', { promptId: 'p1', agentType: 'test-engineer', tool: 'Bash', toolUseId: 'u3', summary: 'Run them' }),
        ev(3, 'PreToolUse', { promptId: 'p1', agentType: 'reviewer', tool: 'Read', toolUseId: 'u4', summary: '/a' }),
        ev(4, 'PreToolUse', { promptId: 'p1', agentType: 'Plan', tool: 'Read', toolUseId: 'u5', summary: '/x' }),
      ]),
    );
    expect(turn.agents.map((a) => [a.type, a.summary, a.tools.map((t) => t.tool)])).toEqual([
      ['reviewer', 'Review the diff', ['Read']],
      ['test-engineer', 'Check the tests', ['Bash']],
      ['Plan', '', ['Read']],
    ]);
    expect(turn.tools).toEqual([]);
  });

  it('takes an Agent call that names no type for a general-purpose agent', () => {
    const [turn] = turns(
      buildActivity([
        ev(0, 'UserPromptSubmit', { promptId: 'p1', summary: 'go' }),
        ev(1, 'PreToolUse', { promptId: 'p1', tool: 'Agent', toolUseId: 'u1', summary: 'Look around' }),
        ev(2, 'PreToolUse', { promptId: 'p1', agentType: 'general-purpose', tool: 'Glob', toolUseId: 'u2', summary: '*.ts' }),
        ev(3, 'PostToolUse', { promptId: 'p1', tool: 'Agent', toolUseId: 'u1' }),
      ]),
    );
    expect(turn.agents).toHaveLength(1);
    expect(turn.agents[0]).toMatchObject({ type: 'general-purpose', endedAt: at(3), tools: [{ tool: 'Glob', count: 1, failed: 0 }] });
  });

  it("ends a turn's running calls, and its subagents', when the turn stops, and pairs a call without an id by tool", () => {
    const [turn] = turns(
      buildActivity([
        ev(0, 'UserPromptSubmit', { promptId: 'p1', summary: 'go' }),
        ev(1, 'PreToolUse', { promptId: 'p1', tool: 'Bash', summary: 'a' }),
        ev(2, 'PostToolUse', { promptId: 'p1', tool: 'Bash' }),
        ev(3, 'PreToolUse', { promptId: 'p1', tool: 'Read', toolUseId: 'u1', summary: '/x' }),
        ev(4, 'PreToolUse', { promptId: 'p1', tool: 'Agent', toolUseId: 'u2', summary: 'look', subagentType: 'Explore' }),
        ev(5, 'PreToolUse', { promptId: 'p1', agentType: 'Explore', tool: 'Glob', toolUseId: 'u3', summary: '*' }),
        ev(9, 'Stop', { promptId: 'p1' }),
      ]),
    );
    expect(turn.calls.map((c) => [c.tool, c.endedAt])).toEqual([
      ['Bash', at(2)],
      ['Read', at(9)],
    ]);
    expect(turn.agents[0]).toMatchObject({ endedAt: at(9), active: null });
    expect(turn.agents[0].calls[0].endedAt).toBe(at(9));
  });

  it('keeps only the latest calls of a lane', () => {
    const [turn] = turns(
      buildActivity([
        ev(0, 'UserPromptSubmit', { promptId: 'p1', summary: 'go' }),
        ...Array.from({ length: 450 }, (_, n) => ev(n + 1, 'PreToolUse', { promptId: 'p1', tool: 'Read', toolUseId: `u${n}`, summary: `${n}` })),
      ]),
    );
    expect(turn.calls).toHaveLength(400);
    expect(turn.calls[0].summary).toBe('50');
    expect(turn.tools).toEqual([{ tool: 'Read', count: 450, failed: 0 }]);
  });

  it('binds an agent id when claude reports one, so later calls and the stop follow it', () => {
    const [turn] = turns(
      buildActivity([
        ev(0, 'UserPromptSubmit', { promptId: 'p1', summary: 'go' }),
        ev(1, 'PreToolUse', { promptId: 'p1', tool: 'Agent', toolUseId: 'u1', summary: 'one', subagentType: 'Explore' }),
        ev(1, 'PreToolUse', { promptId: 'p1', tool: 'Agent', toolUseId: 'u2', summary: 'two', subagentType: 'Explore' }),
        ev(2, 'SubagentStart', { promptId: 'p1', agentId: 'a1', agentType: 'Explore' }),
        ev(2, 'SubagentStart', { promptId: 'p1', agentId: 'a2', agentType: 'Explore' }),
        ev(3, 'PreToolUse', { promptId: 'p1', agentId: 'a2', agentType: 'Explore', tool: 'Read', toolUseId: 'u3', summary: '/b' }),
        ev(4, 'PostToolUseFailure', { promptId: 'p1', agentId: 'a2', agentType: 'Explore', tool: 'Read', toolUseId: 'u3' }),
        ev(5, 'SubagentStop', { promptId: 'p1', agentId: 'a1', agentType: 'Explore' }),
      ]),
    );
    expect(turn.agents.map((a) => [a.summary, a.endedAt, a.tools])).toEqual([
      ['one', at(5), []],
      ['two', null, [{ tool: 'Read', count: 1, failed: 1 }]],
    ]);
  });

  it('labels a prompt that is claude plumbing rather than something you typed', () => {
    const items = turns(
      buildActivity([
        ev(0, 'UserPromptSubmit', { promptId: 'p1', summary: '<agent-message from="a1">done</agent-message>' }),
        ev(1, 'UserPromptSubmit', { promptId: 'p2', summary: '<task-notification>x</task-notification>' }),
        ev(2, 'UserPromptSubmit', { promptId: 'p3', summary: '<command-name>/model</command-name>' }),
        ev(3, 'UserPromptSubmit', { promptId: 'p4', summary: 'a real question' }),
      ]),
    );
    expect(items.map((t) => t.prompt)).toEqual(['Subagent reported back', 'Subagent reported back', 'System message', 'a real question']);
  });

  it('separates turns, marks a compaction between them, and ends a turn left open when the next begins', () => {
    const items = buildActivity([
      ev(0, 'UserPromptSubmit', { promptId: 'p1', summary: 'one' }),
      ev(1, 'PreToolUse', { promptId: 'p1', tool: 'Bash', toolUseId: 'u1', summary: 'a' }),
      ev(5, 'PreCompact', { promptId: 'p1', summary: 'auto' }),
      ev(9, 'UserPromptSubmit', { promptId: 'p2', summary: 'two' }),
      ev(10, 'Stop', { promptId: 'p2' }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(['turn', 'compaction', 'turn']);
    expect(items[0]).toMatchObject({ prompt: 'one', endedAt: at(9) });
    expect(items[1]).toEqual({ kind: 'compaction', at: at(5), trigger: 'auto' });
    expect(items[2]).toMatchObject({ prompt: 'two', startedAt: at(9), endedAt: at(10) });
  });

  it('puts events before any prompt into a turn with no prompt, ignores a subagent Stop, and keeps the last N items', () => {
    const items = buildActivity(
      [
        ev(0, 'PreToolUse', { tool: 'Edit', toolUseId: 'u1', summary: '/a', file: '/a' }),
        ev(1, 'Stop', { agentType: 'Explore' }),
        ev(2, 'Stop'),
        ev(3, 'SessionStart'),
        ...[1, 2, 3].flatMap((n) => [ev(10 + n, 'UserPromptSubmit', { promptId: `p${n}`, summary: `prompt ${n}` }), ev(20 + n, 'Stop', { promptId: `p${n}` })]),
      ],
      2,
    );
    expect(items.map((i) => (i.kind === 'turn' ? i.prompt : i.kind))).toEqual(['prompt 2', 'prompt 3']);
    const all = turns(
      buildActivity([ev(0, 'PreToolUse', { tool: 'Edit', toolUseId: 'u1', summary: '/a' }), ev(1, 'Stop', { agentType: 'Explore' }), ev(2, 'Stop')]),
    );
    expect(all).toEqual([expect.objectContaining({ id: 'turn-1', prompt: '', endedAt: at(2), tools: [{ tool: 'Edit', count: 1, failed: 0 }] })]);
  });

  it('ignores a Skill failure, and a SubagentStop that names no agent', () => {
    const [turn] = turns(
      buildActivity([
        ev(0, 'UserPromptSubmit', { promptId: 'p1', summary: 'go' }),
        ev(2, 'SubagentStop', { promptId: 'p1' }),
        ev(3, 'PostToolUseFailure', { promptId: 'p1', tool: 'Skill' }),
      ]),
    );
    expect(turn.agents).toEqual([]);
    expect(turn.tools).toEqual([]);
  });
});

describe('parseActivityLine', () => {
  it('reads an event line and rejects a blank, cut-off or foreign one', () => {
    expect(parseActivityLine(JSON.stringify(ev(0, 'Stop')))).toEqual(ev(0, 'Stop'));
    expect(['', '  ', '{"at":"2026-', '{"at":"x","event":"Elicitation"}', '{"event":"Stop"}'].map(parseActivityLine)).toEqual([null, null, null, null, null]);
  });
});

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
