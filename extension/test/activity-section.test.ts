// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityItem } from '../../shared/activity';
import type { ControlToHelper } from '../../shared/protocol';
import { type ActivitySection, createActivitySection } from '../src/activity-section';
import { installChrome } from './chrome-mock';
import { isolateDocumentListeners, loadPanelHtml, makeWorkspace } from './fixtures';

isolateDocumentListeners();

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

let fake: ReturnType<typeof installChrome>;
let section: ActivitySection;
let sent: ControlToHelper[];
const a = makeWorkspace({ id: 'ws-a', name: 'Alpha' });
const b = makeWorkspace({ id: 'ws-b', name: 'Beta' });

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (selector: string) => [...document.querySelectorAll(selector)].map((node) => node.textContent);
const follows = () => sent.filter((m): m is Extract<ControlToHelper, { type: 'activity' }> => m.type === 'activity').map((m) => m.id);
const flush = () => vi.advanceTimersByTimeAsync(0);

const items: ActivityItem[] = [
  {
    kind: 'turn',
    id: 'p1',
    prompt: 'fix the bug',
    startedAt: at(600),
    endedAt: at(500),
    skills: [{ name: 'pest', at: at(590) }],
    agents: [],
    tools: [
      { tool: 'Read', count: 3, failed: 0 },
      { tool: 'Bash', count: 2, failed: 1 },
    ],
    active: null,
  },
  { kind: 'compaction', at: at(400), trigger: 'auto' },
  {
    kind: 'turn',
    id: 'p2',
    prompt: 'now review it',
    startedAt: at(90),
    endedAt: null,
    skills: [],
    agents: [
      {
        id: 'a1',
        type: 'reviewer',
        summary: 'Review the diff',
        startedAt: at(60),
        endedAt: at(20),
        tools: [{ tool: 'Grep', count: 4, failed: 0 }],
        active: null,
      },
      {
        id: 'a2',
        type: 'Explore',
        summary: '',
        startedAt: at(30),
        endedAt: null,
        tools: [{ tool: 'Read', count: 1, failed: 0 }],
        active: { tool: 'Read', summary: '/repo/x.ts', at: at(5) },
      },
    ],
    tools: [{ tool: 'Agent', count: 2, failed: 0 }],
    active: { tool: 'Agent', summary: 'Explore the tests', at: at(30) },
  },
];

async function make(): Promise<void> {
  sent = [];
  section = createActivitySection({
    send: (message) => {
      sent.push(message);
      return true;
    },
  });
  await flush();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = installChrome();
  loadPanelHtml();
});
afterEach(() => vi.useRealTimers());

describe('activity section', () => {
  it('follows the workspace in view once its collapsed state is known, and stops while collapsed', async () => {
    await make();
    expect(text('#activity-body .empty')).toEqual(['No workspace is selected.']);
    expect(follows()).toEqual([]);
    section.setWorkspace(a);
    expect(follows()).toEqual(['ws-a']);
    expect(text('#activity-body .empty')).toEqual(['Loading…']);

    $('activity-toggle').click();
    expect($('activity').classList.contains('collapsed')).toBe(true);
    expect(fake.storage.local.activityCollapsed).toBe(true);
    expect(follows()).toEqual(['ws-a', null]);
    // A change of workspace while collapsed is not followed either.
    section.setWorkspace(b);
    expect(follows()).toEqual(['ws-a', null]);

    $('activity-toggle').click();
    expect(follows()).toEqual(['ws-a', null, 'ws-b']);
    expect(fake.storage.local.activityCollapsed).toBe(false);
  });

  it('starts collapsed when it was left that way, and expands on request', async () => {
    fake.storage.local.activityCollapsed = true;
    await make();
    section.setWorkspace(a);
    expect($('activity').classList.contains('collapsed')).toBe(true);
    expect(follows()).toEqual([]);
    section.expand();
    expect($('activity').classList.contains('collapsed')).toBe(false);
    expect(follows()).toEqual(['ws-a']);
    // Expanding what is open is nothing.
    section.expand();
    expect(follows()).toEqual(['ws-a']);
  });

  it('draws each turn as a row, the newest open with its skills, agents, tallies and running call', async () => {
    await make();
    section.setWorkspace(a);
    section.setActivity({ type: 'activity', id: 'ws-a', items, error: null });
    expect(text('.turn-prompt')).toEqual(['fix the bug', 'now review it']);
    expect(text('.turn-elapsed')).toEqual(['1m 40s', '1m 30s']);
    expect([...document.querySelectorAll('.turn')].map((t) => `${t.classList.contains('running')} ${t.classList.contains('open')}`)).toEqual([
      'false false',
      'true true',
    ]);
    expect(text('.compaction')).toEqual(['Compacted (auto)']);
    // Only the open turn has a body.
    expect(text('.node.skill .node-name')).toEqual([]);
    expect(text('.node.agent .node-name')).toEqual(['reviewer', 'Explore']);
    expect(text('.node.agent .node-summary')).toEqual(['Review the diff']);
    expect(text('.node.agent .node-elapsed')).toEqual(['40s', '30s']);
    expect(text('.tally .tool')).toEqual(['Grep 4', 'Read 1', 'Agent 2']);
    expect(text('.active-call .summary')).toEqual(['/repo/x.ts', 'Explore the tests']);
    expect($('activity-state').textContent).toBe('Working');
    expect($('activity-state').classList.contains('running')).toBe(true);

    // Elapsed times tick while following.
    vi.advanceTimersByTime(10_000);
    expect(text('.turn-elapsed')).toEqual(['1m 40s', '1m 40s']);
    expect(text('.node.agent .node-elapsed')).toEqual(['40s', '40s']);
  });

  it('opens and closes a turn from its row, by click or keyboard, and forgets that on a new workspace', async () => {
    await make();
    section.setWorkspace(a);
    section.setActivity({ type: 'activity', id: 'ws-a', items, error: null });
    const heads = () => [...document.querySelectorAll<HTMLElement>('.turn-head')];
    heads()[0].click();
    expect(text('.node.skill .node-name')).toEqual(['pest']);
    expect(document.querySelector('.tally .tool.failed')?.textContent).toBe('Bash 2');
    expect(heads()[0].getAttribute('aria-expanded')).toBe('true');
    heads()[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(text('.node.agent .node-name')).toEqual([]);
    expect(heads()[1].getAttribute('aria-expanded')).toBe('false');
    // The choice survives the next update from the helper.
    section.setActivity({ type: 'activity', id: 'ws-a', items, error: null });
    expect(text('.node.skill .node-name')).toEqual(['pest']);
    expect(text('.node.agent .node-name')).toEqual([]);
    // A new workspace starts afresh: newest open, the rest closed.
    section.setWorkspace(b);
    section.setActivity({ type: 'activity', id: 'ws-b', items, error: null });
    expect(text('.node.skill .node-name')).toEqual([]);
    expect(text('.node.agent .node-name')).toEqual(['reviewer', 'Explore']);
  });

  it('says when there is nothing, when the workspace has no session, and when none is selected', async () => {
    await make();
    section.setWorkspace(a);
    section.setActivity({ type: 'activity', id: 'ws-a', items: [], error: null });
    expect(text('#activity-body .empty')).toEqual(['Nothing yet. Ask claude something and its work shows up here.']);
    expect($('activity-state').textContent).toBe('');
    section.setActivity({ type: 'activity', id: 'ws-a', items: [], error: 'This workspace has no claude session yet.' });
    expect(text('#activity-body .empty')).toEqual(['This workspace has no claude session yet.']);
    section.setWorkspace(undefined);
    expect(text('#activity-body .empty')).toEqual(['No workspace is selected.']);
    expect(follows()).toEqual(['ws-a', null]);
  });

  it('moves to the next workspace, ignoring an answer for the one it left, and shows a quiet turn as such', async () => {
    await make();
    section.setWorkspace(a);
    section.setWorkspace(b);
    expect(follows()).toEqual(['ws-a', 'ws-b']);
    section.setActivity({ type: 'activity', id: 'ws-a', items, error: null });
    expect(text('#activity-body .empty')).toEqual(['Loading…']);
    section.setActivity({
      type: 'activity',
      id: 'ws-b',
      items: [{ kind: 'turn', id: 'turn-1', prompt: '', startedAt: at(10), endedAt: at(5), skills: [], agents: [], tools: [], active: null }],
      error: null,
    });
    expect(text('.turn-prompt')).toEqual(['Earlier in the session']);
    expect(text('.node.quiet')).toEqual(['No tool calls.']);
    expect($('activity-state').textContent).toBe('Idle');
    // The same workspace again, as every state update brings, is not a new follow.
    section.setWorkspace(b);
    expect(follows()).toEqual(['ws-a', 'ws-b']);
  });
});
