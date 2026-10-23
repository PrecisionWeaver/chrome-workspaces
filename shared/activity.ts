/**
 * What a workspace's claude is doing, turn by turn: the prompt, the skills it invoked, the subagents it
 * spawned and the tools each of them called. Built from the event lines hooks/session-state.ts appends.
 */

export type ActivityEventName =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'Stop'
  | 'PreCompact';

export const ACTIVITY_EVENTS: ReadonlySet<string> = new Set<ActivityEventName>([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'PreCompact',
]);

/** One line of `sessions/<id>.events.jsonl`. */
export interface ActivityEvent {
  /** ISO 8601. */
  at: string;
  event: ActivityEventName;
  /** The prompt the event belongs to; claude sets it after the first prompt. */
  promptId?: string;
  /** Set when the event fired inside a subagent. */
  agentId?: string;
  agentType?: string;
  tool?: string;
  toolUseId?: string;
  /** The prompt, the tool call in a line, the skill's name, or what triggered a compaction. */
  summary?: string;
  file?: string;
}

export interface ToolTally {
  tool: string;
  count: number;
  failed: number;
}

/** A tool call that has started and not finished. */
export interface ActivityCall {
  tool: string;
  summary: string;
  at: string;
}

export interface ActivitySkill {
  name: string;
  at: string;
}

export interface ActivityAgent {
  id: string;
  type: string;
  /** What it was asked to do, from the Agent tool call that spawned it. */
  summary: string;
  startedAt: string;
  endedAt: string | null;
  tools: ToolTally[];
  active: ActivityCall | null;
}

export interface ActivityTurn {
  kind: 'turn';
  id: string;
  /** What you asked; empty for a turn whose start is before the lines that were read. */
  prompt: string;
  startedAt: string;
  endedAt: string | null;
  skills: ActivitySkill[];
  agents: ActivityAgent[];
  /** Tools claude called itself, outside any subagent. */
  tools: ToolTally[];
  active: ActivityCall | null;
}

export interface ActivityCompaction {
  kind: 'compaction';
  at: string;
  trigger: string;
}

export type ActivityItem = ActivityTurn | ActivityCompaction;

export const ACTIVITY_LIMIT = 40;

const AGENT_TOOLS = new Set(['Agent', 'Task']);

function tally(tools: ToolTally[], name: string): ToolTally {
  let entry = tools.find((t) => t.tool === name);
  if (!entry) {
    entry = { tool: name, count: 0, failed: 0 };
    tools.push(entry);
  }
  return entry;
}

/** Reads one event line; null for a line that is not one (cut off by a write in progress, say). */
export function parseActivityLine(line: string): ActivityEvent | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as Partial<ActivityEvent>;
    if (typeof parsed.at !== 'string' || typeof parsed.event !== 'string' || !ACTIVITY_EVENTS.has(parsed.event)) return null;
    return parsed as ActivityEvent;
  } catch {
    return null;
  }
}

/**
 * Folds events into turns, oldest first, keeping the last `limit` items. A tool call carrying an agent id
 * lands under that agent; a Skill call is listed by name; a subagent takes the description of the newest
 * Agent call still waiting for one, which is the call that spawned it.
 */
export function buildActivity(events: readonly ActivityEvent[], limit = ACTIVITY_LIMIT): ActivityItem[] {
  const items: ActivityItem[] = [];
  // Held in an object: the closures below assign it, which a plain variable's narrowing would not see.
  const state: { turn: ActivityTurn | null } = { turn: null };
  let anonymous = 0;
  // Agent tool calls not yet matched to a SubagentStart, newest last.
  let pendingAgents: { toolUseId: string | undefined; summary: string }[] = [];

  const open = (event: ActivityEvent, prompt: string): ActivityTurn => {
    if (state.turn && !state.turn.endedAt) state.turn.endedAt = event.at;
    const turn: ActivityTurn = {
      kind: 'turn',
      id: event.promptId ?? `turn-${++anonymous}`,
      prompt,
      startedAt: event.at,
      endedAt: null,
      skills: [],
      agents: [],
      tools: [],
      active: null,
    };
    pendingAgents = [];
    state.turn = turn;
    items.push(turn);
    return turn;
  };
  // A tail that starts mid-turn still has somewhere to put what follows.
  const current = (event: ActivityEvent): ActivityTurn => state.turn ?? open(event, '');

  const agentOf = (event: ActivityEvent, t: ActivityTurn): ActivityAgent => {
    const id = event.agentId as string;
    let agent = t.agents.find((a) => a.id === id);
    if (!agent) {
      const spawned = pendingAgents.pop();
      agent = { id, type: event.agentType ?? 'agent', summary: spawned?.summary ?? '', startedAt: event.at, endedAt: null, tools: [], active: null };
      t.agents.push(agent);
    }
    return agent;
  };

  for (const event of events) {
    switch (event.event) {
      case 'UserPromptSubmit':
        open(event, event.summary ?? '');
        break;
      case 'SessionStart':
        if (state.turn && !state.turn.endedAt) state.turn.endedAt = event.at;
        break;
      case 'Stop':
        // A Stop inside a subagent is that agent's, and SubagentStop says so.
        if (!event.agentId && state.turn && !state.turn.endedAt) {
          state.turn.endedAt = event.at;
          state.turn.active = null;
        }
        break;
      case 'PreCompact':
        items.push({ kind: 'compaction', at: event.at, trigger: event.summary ?? '' });
        break;
      case 'SubagentStart': {
        if (event.agentId) agentOf(event, current(event));
        break;
      }
      case 'SubagentStop': {
        const t = current(event);
        const agent = event.agentId ? t.agents.find((a) => a.id === event.agentId) : undefined;
        if (agent) {
          agent.endedAt = event.at;
          agent.active = null;
        }
        break;
      }
      case 'PreToolUse': {
        const t = current(event);
        const tool = event.tool ?? 'tool';
        const summary = event.summary ?? '';
        if (event.agentId) {
          const agent = agentOf(event, t);
          tally(agent.tools, tool).count++;
          agent.active = { tool, summary, at: event.at };
          break;
        }
        if (tool === 'Skill') {
          t.skills.push({ name: summary, at: event.at });
          break;
        }
        tally(t.tools, tool).count++;
        t.active = { tool, summary, at: event.at };
        if (AGENT_TOOLS.has(tool)) pendingAgents.push({ toolUseId: event.toolUseId, summary });
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const t = current(event);
        const failed = event.event === 'PostToolUseFailure';
        const tool = event.tool ?? 'tool';
        if (event.agentId) {
          const agent = t.agents.find((a) => a.id === event.agentId);
          if (!agent) break;
          if (failed) tally(agent.tools, tool).failed++;
          if (!agent.active || !event.toolUseId || agent.active.at <= event.at) agent.active = null;
          break;
        }
        if (failed && tool !== 'Skill') tally(t.tools, tool).failed++;
        if (AGENT_TOOLS.has(tool)) pendingAgents = pendingAgents.filter((p) => p.toolUseId !== event.toolUseId);
        t.active = null;
        break;
      }
    }
  }
  return items.slice(-limit);
}
