import type { ActivityAgent, ActivityCall, ActivityItem, ActivityTurn, ToolTally } from '../../shared/activity';
import type { ControlToClient, ControlToHelper, Workspace } from '../../shared/protocol';
import { $, el } from './dom';
import { formatDuration } from './format';

export interface ActivitySectionOptions {
  send(message: ControlToHelper): boolean;
}

export interface ActivitySection {
  /** The workspace in view; the section follows it while expanded. */
  setWorkspace(workspace: Workspace | undefined): void;
  setActivity(message: Extract<ControlToClient, { type: 'activity' }>): void;
  /** Opens the accordion if it is collapsed. */
  expand(): void;
}

// Elapsed times tick while a turn is running.
const TICK_MS = 1000;

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const elapsed = (from: string, to: string | null, now: number) =>
  formatDuration(Math.max(0, Math.round(((to ? Date.parse(to) : now) - Date.parse(from)) / 1000)));

function tallyRow(tools: ToolTally[]): HTMLElement {
  const row = el('span', '', 'tally');
  for (const { tool, count, failed } of tools) {
    const chip = el('span', '', `tool${failed ? ' failed' : ''}`);
    chip.append(el('span', tool), ' ', el('span', String(count), 'count'));
    chip.title = failed ? `${count} call${count === 1 ? '' : 's'}, ${failed} failed` : `${count} call${count === 1 ? '' : 's'}`;
    row.append(chip);
  }
  return row;
}

function activeCall(call: ActivityCall): HTMLElement {
  const row = el('div', '', 'active-call');
  row.append(el('span', call.tool, 'tool'), el('span', call.summary, 'summary'));
  row.title = call.summary;
  return row;
}

function agentNode(agent: ActivityAgent, now: number): HTMLElement {
  const node = el('div', '', `node agent${agent.endedAt ? '' : ' running'}`);
  const head = el('div', '', 'node-head');
  head.append(el('span', agent.type, 'node-name'));
  if (agent.summary) {
    const summary = el('span', agent.summary, 'node-summary');
    summary.title = agent.summary;
    head.append(summary);
  }
  head.append(el('span', elapsed(agent.startedAt, agent.endedAt, now), 'node-elapsed'));
  node.append(head);
  if (agent.tools.length) node.append(tallyRow(agent.tools));
  if (agent.active) node.append(activeCall(agent.active));
  return node;
}

function turnRow(turn: ActivityTurn, now: number, open: boolean, toggle: () => void): HTMLElement {
  const row = el('div', '', `turn${turn.endedAt ? '' : ' running'}${open ? ' open' : ''}`);
  const head = el('div', '', 'turn-head');
  head.tabIndex = 0;
  head.setAttribute('role', 'button');
  head.setAttribute('aria-expanded', String(open));
  const prompt = el('span', turn.prompt || 'Earlier in the session', `turn-prompt${turn.prompt ? '' : ' earlier'}`);
  head.title = turn.prompt;
  head.append(el('span', clock(turn.startedAt), 'turn-time'), prompt, el('span', elapsed(turn.startedAt, turn.endedAt, now), 'turn-elapsed'));
  head.addEventListener('click', toggle);
  head.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggle();
    }
  });
  row.append(head);
  if (!open) return row;

  const body = el('div', '', 'turn-body');
  for (const skill of turn.skills) {
    const node = el('div', '', 'node skill');
    node.append(el('span', 'Skill', 'node-kind'), el('span', skill.name, 'node-name'));
    body.append(node);
  }
  for (const agent of turn.agents) body.append(agentNode(agent, now));
  if (turn.tools.length || turn.active) {
    const node = el('div', '', `node own${turn.active ? ' running' : ''}`);
    node.append(el('span', 'Claude', 'node-kind'));
    if (turn.tools.length) node.append(tallyRow(turn.tools));
    if (turn.active) node.append(activeCall(turn.active));
    body.append(node);
  }
  if (!body.childElementCount) body.append(el('div', 'No tool calls.', 'node quiet'));
  row.append(body);
  return row;
}

/**
 * What the workspace's claude is doing, turn by turn, in the list beside the terminal: each prompt as a row, the
 * newest open to show the skills it invoked, the subagents it spawned and the tools each called, from the events
 * its hooks record. While the section is expanded the helper sends the list again after every event.
 */
export function createActivitySection({ send }: ActivitySectionOptions): ActivitySection {
  const section = $<HTMLElement>('activity');
  const state = $<HTMLSpanElement>('activity-state');
  const body = $<HTMLDivElement>('activity-body');

  let workspace: Workspace | undefined;
  // What the helper last sent for the workspace in view; null until it answers.
  let activity: { id: string; items: ActivityItem[]; error: string | null } | null = null;
  // Turns opened or closed by hand; the newest turn is open unless closed here.
  const opened = new Map<string, boolean>();
  let followingId: string | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const collapsed = () => section.classList.contains('collapsed');

  function render(): void {
    const stuck = body.scrollTop + body.clientHeight >= body.scrollHeight - 4;
    body.replaceChildren();
    state.textContent = '';
    state.classList.remove('running');
    if (!workspace) {
      body.append(el('div', 'No workspace is selected.', 'empty'));
      return;
    }
    if (!activity || activity.id !== workspace.id) {
      body.append(el('div', 'Loading…', 'empty'));
      return;
    }
    if (activity.error) {
      body.append(el('div', activity.error, 'empty'));
      return;
    }
    if (activity.items.length === 0) {
      body.append(el('div', 'Nothing yet. Ask claude something and its work shows up here.', 'empty'));
      return;
    }
    const now = Date.now();
    const last = activity.items.at(-1);
    for (const item of activity.items) {
      if (item.kind === 'compaction') {
        body.append(el('div', `Compacted${item.trigger ? ` (${item.trigger})` : ''}`, 'compaction'));
        continue;
      }
      const open = opened.get(item.id) ?? item === last;
      body.append(
        turnRow(item, now, open, () => {
          opened.set(item.id, !open);
          render();
        }),
      );
    }
    const running = last?.kind === 'turn' && !last.endedAt;
    state.textContent = running ? 'Working' : 'Idle';
    state.classList.toggle('running', running);
    // Reading older turns is left alone; otherwise the newest stays in view.
    if (stuck) body.scrollTop = body.scrollHeight;
  }

  /** Follows the workspace in view while the section is expanded, and nothing while it is collapsed. */
  function follow(): void {
    const wanted = collapsed() ? null : (workspace?.id ?? null);
    if (wanted === followingId) return;
    followingId = wanted;
    activity = null;
    send({ type: 'activity', id: wanted });
    if (wanted && !ticker) ticker = setInterval(render, TICK_MS);
    if (!wanted && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
    render();
  }

  $<HTMLButtonElement>('activity-toggle').addEventListener('click', () => {
    const nowCollapsed = section.classList.toggle('collapsed');
    void chrome.storage.local.set({ activityCollapsed: nowCollapsed });
    follow();
  });
  void chrome.storage.local.get('activityCollapsed').then(({ activityCollapsed }) => {
    section.classList.toggle('collapsed', activityCollapsed === true);
    follow();
  });

  render();

  return {
    setWorkspace(next) {
      const changed = next?.id !== workspace?.id;
      workspace = next;
      opened.clear();
      if (changed) follow();
      else render();
    },
    setActivity(message) {
      if (message.id !== workspace?.id) return;
      activity = { id: message.id, items: message.items, error: message.error };
      render();
    },
    expand() {
      if (!collapsed()) return;
      section.classList.remove('collapsed');
      void chrome.storage.local.set({ activityCollapsed: false });
      follow();
    },
  };
}
