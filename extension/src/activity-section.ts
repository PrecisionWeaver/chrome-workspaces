import type { ActivityItem, ActivityTurn } from '../../shared/activity';
import type { ControlToClient, ControlToHelper, Workspace } from '../../shared/protocol';
import { drawTurn, legend } from './activity-chart';
import { $, el } from './dom';

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

// A running turn's lanes grow with the clock.
const TICK_MS = 1000;
const CHIP_PROMPT = 18;

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * What the workspace's claude is doing, drawn as a swimlane per turn: a strip of turns to pick from, and for the
 * picked one (the newest by default) a lane for claude and one per subagent, with each tool call a block along
 * the time axis. It sits in the list beside the terminal; while it is expanded the helper sends the list again
 * after every event.
 */
export function createActivitySection({ send }: ActivitySectionOptions): ActivitySection {
  const section = $<HTMLElement>('activity');
  const state = $<HTMLSpanElement>('activity-state');
  const body = $<HTMLDivElement>('activity-body');

  let workspace: Workspace | undefined;
  // What the helper last sent for the workspace in view; null until it answers.
  let activity: { id: string; items: ActivityItem[]; error: string | null } | null = null;
  // The turn picked from the strip; null follows the newest.
  let picked: string | null = null;
  let followingId: string | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const collapsed = () => section.classList.contains('collapsed');

  function chip(turn: ActivityTurn, selected: boolean): HTMLButtonElement {
    const button = el('button', '', `chip${selected ? ' selected' : ''}${turn.endedAt ? '' : ' running'}`);
    button.type = 'button';
    const prompt = turn.prompt.length > CHIP_PROMPT ? `${turn.prompt.slice(0, CHIP_PROMPT - 1)}…` : turn.prompt || 'Earlier';
    button.append(el('span', clock(turn.startedAt), 'chip-time'), el('span', prompt, 'chip-prompt'));
    button.title = turn.prompt;
    button.setAttribute('aria-pressed', String(selected));
    return button;
  }

  function paint(): void {
    // The strip is rebuilt on every tick and every event, so where it was scrolled to is put back.
    const stripScroll = body.querySelector('.chips')?.scrollLeft ?? 0;
    const bodyScroll = body.scrollTop;
    body.replaceChildren();
    state.textContent = '';
    state.classList.remove('running');
    const empty = (text: string) => body.append(el('div', text, 'empty'));
    if (!workspace) {
      empty('No workspace is selected.');
      return;
    }
    if (!activity || activity.id !== workspace.id) {
      empty('Loading…');
      return;
    }
    if (activity.error) {
      empty(activity.error);
      return;
    }
    const turns = activity.items.filter((item): item is ActivityTurn => item.kind === 'turn');
    if (turns.length === 0) {
      empty('Nothing yet. Ask claude something and its work shows up here.');
      return;
    }

    const newest = turns.at(-1) as ActivityTurn;
    const shown = turns.find((turn) => turn.id === picked) ?? newest;
    const strip = el('div', '', 'chips');
    // Newest first, so the turn being worked on is at the left edge.
    for (const item of [...activity.items].reverse()) {
      if (item.kind === 'compaction') {
        const gap = el('span', '', 'chip-gap');
        gap.title = `Context compacted${item.trigger ? ` (${item.trigger})` : ''}`;
        strip.append(gap);
        continue;
      }
      const button = chip(item, item === shown);
      button.addEventListener('click', () => {
        picked = item === newest ? null : item.id;
        render();
      });
      strip.append(button);
    }
    const prompt = el('div', shown.prompt || 'Earlier in the session', `turn-prompt${shown.prompt ? '' : ' earlier'}`);
    prompt.title = shown.prompt;
    body.append(strip, prompt, drawTurn(shown, Date.now()), legend());
    strip.scrollLeft = stripScroll;
    body.scrollTop = bodyScroll;

    const running = !newest.endedAt;
    state.textContent = running ? 'Working' : 'Idle';
    state.classList.toggle('running', running);
  }

  const render = paint;

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
      if (changed) {
        picked = null;
        follow();
      } else render();
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
