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
  /** On an Agent tool call: the type of subagent it starts. */
  subagentType?: string;
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

/** One tool call, for drawing where in the turn it ran. */
export interface ActivityCallRecord {
  id: string;
  tool: string;
  summary: string;
  at: string;
  /** Null while the call is running. */
  endedAt: string | null;
  failed: boolean;
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
  calls: ActivityCallRecord[];
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
  calls: ActivityCallRecord[];
  active: ActivityCall | null;
}

export interface ActivityCompaction {
  kind: 'compaction';
  at: string;
  trigger: string;
}

export type ActivityItem = ActivityTurn | ActivityCompaction;

export const ACTIVITY_LIMIT = 40;
/** The most calls kept for one lane of a turn, so a very long turn stays drawable. */
export const CALLS_PER_LANE = 400;

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

interface Lane {
  calls: ActivityCallRecord[];
  active: ActivityCall | null;
}

function startCall(lane: Lane, event: ActivityEvent): void {
  lane.calls.push({
    id: event.toolUseId ?? `${event.tool}-${event.at}`,
    tool: event.tool ?? 'tool',
    summary: event.summary ?? '',
    at: event.at,
    endedAt: null,
    failed: false,
  });
  if (lane.calls.length > CALLS_PER_LANE) lane.calls.shift();
}

function endCall(lane: Lane, event: ActivityEvent, failed: boolean): void {
  for (let i = lane.calls.length - 1; i >= 0; i--) {
    const call = lane.calls[i];
    if (call.endedAt || (event.toolUseId ? call.id !== event.toolUseId : call.tool !== event.tool)) continue;
    call.endedAt = event.at;
    call.failed = failed;
    return;
  }
}

/** Ends whatever a lane still has running, as when its turn or agent finishes. */
function closeCalls(lane: Lane, at: string): void {
  for (const call of lane.calls) call.endedAt ??= at;
  lane.active = null;
}

/** A prompt that is claude's own plumbing (a subagent's report, a task notification) rather than something you typed. */
function promptLabel(summary: string): string {
  if (!summary.startsWith('<')) return summary;
  return /^<(agent-message|task-notification)/.test(summary) ? 'Subagent reported back' : 'System message';
}

/**
 * Folds events into turns, oldest first, keeping the last `limit` items. An Agent tool call starts a subagent
 * node at once, and its result ends it. Claude Code names the subagent on every event inside it (`agentType`)
 * and, in some builds, gives an id too, so a tool call lands under the newest running agent of that type, or
 * the one the id was bound to. Two agents of one type running together share their calls, which the type cannot tell apart.
 */
export function buildActivity(events: readonly ActivityEvent[], limit = ACTIVITY_LIMIT): ActivityItem[] {
  const items: ActivityItem[] = [];
  // Held in an object: the closures below assign it, which a plain variable's narrowing would not see.
  const state: { turn: ActivityTurn | null } = { turn: null };
  let anonymous = 0;
  // The agent id claude reported for a node, when it reports one.
  const bound = new Map<ActivityAgent, string>();

  /** A turn ending ends everything still running in it, subagents included. */
  const finish = (turn: ActivityTurn, at: string): void => {
    turn.endedAt = at;
    closeCalls(turn, at);
    for (const agent of turn.agents) {
      agent.endedAt ??= at;
      closeCalls(agent, at);
    }
  };

  const open = (event: ActivityEvent, prompt: string): ActivityTurn => {
    if (state.turn && !state.turn.endedAt) finish(state.turn, event.at);
    const turn: ActivityTurn = {
      kind: 'turn',
      id: event.promptId ?? `turn-${++anonymous}`,
      prompt,
      startedAt: event.at,
      endedAt: null,
      skills: [],
      agents: [],
      tools: [],
      calls: [],
      active: null,
    };
    state.turn = turn;
    items.push(turn);
    return turn;
  };
  // A tail that starts mid-turn still has somewhere to put what follows.
  const current = (event: ActivityEvent): ActivityTurn => state.turn ?? open(event, '');

  const spawn = (t: ActivityTurn, event: ActivityEvent, id: string, type: string, summary: string): ActivityAgent => {
    const agent: ActivityAgent = { id, type, summary, startedAt: event.at, endedAt: null, tools: [], calls: [], active: null };
    t.agents.push(agent);
    return agent;
  };

  /** The agent an event inside a subagent belongs to; one seen only through its tools gets a node of its own. */
  const agentOf = (event: ActivityEvent, t: ActivityTurn): ActivityAgent => {
    const running = t.agents.filter((a) => !a.endedAt);
    if (event.agentId) {
      const known = t.agents.find((a) => bound.get(a) === event.agentId);
      if (known) return known;
      const free = running.find((a) => !bound.has(a) && (!event.agentType || a.type === event.agentType));
      if (free) {
        bound.set(free, event.agentId);
        return free;
      }
    } else if (event.agentType) {
      const match = [...running].reverse().find((a) => a.type === event.agentType);
      if (match) return match;
    }
    const agent = spawn(t, event, event.toolUseId ?? `agent-${++anonymous}`, event.agentType ?? 'agent', '');
    if (event.agentId) bound.set(agent, event.agentId);
    return agent;
  };

  const inSubagent = (event: ActivityEvent) => Boolean(event.agentId || event.agentType);

  for (const event of events) {
    switch (event.event) {
      case 'UserPromptSubmit':
        open(event, promptLabel(event.summary ?? ''));
        break;
      case 'SessionStart':
        if (state.turn && !state.turn.endedAt) finish(state.turn, event.at);
        break;
      case 'Stop':
        // A Stop inside a subagent is that agent's, and SubagentStop says so.
        if (!inSubagent(event) && state.turn && !state.turn.endedAt) finish(state.turn, event.at);
        break;
      case 'PreCompact':
        items.push({ kind: 'compaction', at: event.at, trigger: event.summary ?? '' });
        break;
      case 'SubagentStart':
        if (inSubagent(event)) agentOf(event, current(event));
        break;
      case 'SubagentStop': {
        const t = current(event);
        const agent = inSubagent(event) ? agentOf(event, t) : undefined;
        if (agent) {
          agent.endedAt = event.at;
          closeCalls(agent, event.at);
        }
        break;
      }
      case 'PreToolUse': {
        const t = current(event);
        const tool = event.tool ?? 'tool';
        const summary = event.summary ?? '';
        if (inSubagent(event)) {
          const agent = agentOf(event, t);
          tally(agent.tools, tool).count++;
          startCall(agent, event);
          agent.active = { tool, summary, at: event.at };
          break;
        }
        if (tool === 'Skill') {
          t.skills.push({ name: summary, at: event.at });
          break;
        }
        if (AGENT_TOOLS.has(tool)) {
          spawn(t, event, event.toolUseId ?? `agent-${++anonymous}`, event.subagentType ?? 'general-purpose', summary);
          break;
        }
        tally(t.tools, tool).count++;
        startCall(t, event);
        t.active = { tool, summary, at: event.at };
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const t = current(event);
        const failed = event.event === 'PostToolUseFailure';
        const tool = event.tool ?? 'tool';
        if (inSubagent(event)) {
          const agent = agentOf(event, t);
          if (failed) tally(agent.tools, tool).failed++;
          endCall(agent, event, failed);
          agent.active = null;
          break;
        }
        if (AGENT_TOOLS.has(tool)) {
          // The Agent call returning is the subagent finishing.
          const agent = t.agents.find((a) => a.id === event.toolUseId && !a.endedAt);
          if (agent) {
            agent.endedAt = event.at;
            closeCalls(agent, event.at);
          }
          break;
        }
        if (failed && tool !== 'Skill') tally(t.tools, tool).failed++;
        if (tool !== 'Skill') endCall(t, event, failed);
        t.active = null;
        break;
      }
    }
  }
  return items.slice(-limit);
}
