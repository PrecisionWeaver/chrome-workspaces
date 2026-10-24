// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityAgent, ActivityCallRecord, ActivityItem, ActivityTurn } from '../../shared/activity';
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
const text = (selector: string, root: ParentNode = document) => [...root.querySelectorAll(selector)].map((node) => node.textContent);
const follows = () => sent.filter((m): m is Extract<ControlToHelper, { type: 'activity' }> => m.type === 'activity').map((m) => m.id);
const flush = () => vi.advanceTimersByTimeAsync(0);
const nav = () => $('activity-body');
// A label's tooltip is a child element, so its name is its first text node.
const labels = (root: ParentNode) => [...root.querySelectorAll('.lane-label')].map((node) => node.firstChild?.textContent);
const classes = (selector: string, root: ParentNode = nav()) => [...root.querySelectorAll(selector)].map((node) => node.getAttribute('class'));

const call = (id: string, tool: string, from: number, to: number | null, rest: Partial<ActivityCallRecord> = {}): ActivityCallRecord => ({
  id,
  tool,
  summary: `${tool} summary`,
  at: at(from),
  endedAt: to === null ? null : at(to),
  failed: false,
  ...rest,
});
const agent = (id: string, type: string, rest: Partial<ActivityAgent> = {}): ActivityAgent => ({
  id,
  type,
  summary: '',
  startedAt: at(60),
  endedAt: at(20),
  tools: [],
  calls: [],
  active: null,
  ...rest,
});
const turn = (id: string, prompt: string, rest: Partial<ActivityTurn> = {}): ActivityTurn => ({
  kind: 'turn',
  id,
  prompt,
  startedAt: at(100),
  endedAt: at(10),
  skills: [],
  agents: [],
  tools: [],
  calls: [],
  active: null,
  ...rest,
});

const older = turn('p1', 'fix the bug', {
  startedAt: at(600),
  endedAt: at(500),
  skills: [{ name: 'pest', at: at(590) }],
  calls: [call('c1', 'Read', 595, 594)],
});
const newest = turn('p2', 'now review it', {
  startedAt: at(90),
  endedAt: null,
  calls: [
    call('c2', 'Bash', 80, 70, { failed: true }),
    call('c3', 'Edit', 60, 55),
    call('c4', 'WebFetch', 40, 38),
    call('c5', 'mcp__x__y', 30, 28),
    call('c6', 'Grep', 5, null),
  ],
  agents: [
    agent('a1', 'reviewer', { summary: 'Review the diff', calls: [call('d1', 'Read', 55, 50), call('d2', 'Read', 45, 40)] }),
    agent('a2', 'Explore', { startedAt: at(30), endedAt: null, calls: [call('d3', 'Glob', 12, null)] }),
  ],
});
const items: ActivityItem[] = [older, { kind: 'compaction', at: at(400), trigger: 'auto' }, newest];

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

describe('following', () => {
  it('follows the workspace in view once its collapsed state is known, and stops while collapsed', async () => {
    await make();
    expect(text('.empty', nav())).toEqual(['No workspace is selected.']);
    expect(follows()).toEqual([]);
    section.setWorkspace(a);
    expect(follows()).toEqual(['ws-a']);
    expect(text('.empty', nav())).toEqual(['Loading…']);

    $('activity-toggle').click();
    expect($('activity').classList.contains('collapsed')).toBe(true);
    expect(fake.storage.local.activityCollapsed).toBe(true);
    expect(follows()).toEqual(['ws-a', null]);
    section.setWorkspace(b);
    expect(follows()).toEqual(['ws-a', null]);
    $('activity-toggle').click();
    expect(follows()).toEqual(['ws-a', null, 'ws-b']);
    expect(fake.storage.local.activityCollapsed).toBe(false);
  });

  it('starts collapsed when left that way, and expands on request', async () => {
    fake.storage.local.activityCollapsed = true;
    await make();
    section.setWorkspace(a);
    expect(follows()).toEqual([]);
    section.expand();
    expect($('activity').classList.contains('collapsed')).toBe(false);
    expect(follows()).toEqual(['ws-a']);
    section.expand();
    expect(follows()).toEqual(['ws-a']);
  });

  it('moves to the next workspace, ignoring an answer for the one it left', async () => {
    await make();
    section.setWorkspace(a);
    section.setWorkspace(b);
    expect(follows()).toEqual(['ws-a', 'ws-b']);
    section.setActivity({ type: 'activity', id: 'ws-a', items, error: null });
    expect(text('.empty', nav())).toEqual(['Loading…']);
    section.setActivity({ type: 'activity', id: 'ws-b', items: [older], error: null });
    expect(text('.chip-prompt', nav())).toEqual(['fix the bug']);
    section.setWorkspace(b);
    expect(follows()).toEqual(['ws-a', 'ws-b']);
  });

  it('says when there is nothing, when the workspace has no session, and when none is selected', async () => {
    await make();
    section.setWorkspace(a);
    section.setActivity({ type: 'activity', id: 'ws-a', items: [], error: null });
    expect(text('.empty', nav())).toEqual(['Nothing yet. Ask claude something and its work shows up here.']);
    expect($('activity-state').textContent).toBe('');
    section.setActivity({ type: 'activity', id: 'ws-a', items: [{ kind: 'compaction', at: at(1), trigger: '' }], error: null });
    expect(text('.empty', nav())).toEqual(['Nothing yet. Ask claude something and its work shows up here.']);
    section.setActivity({ type: 'activity', id: 'ws-a', items: [], error: 'This workspace has no claude session yet.' });
    expect(text('.empty', nav())).toEqual(['This workspace has no claude session yet.']);
    section.setWorkspace(undefined);
    expect(text('.empty', nav())).toEqual(['No workspace is selected.']);
    expect(follows()).toEqual(['ws-a', null]);
  });
});

describe('the swimlane', () => {
  beforeEach(async () => {
    await make();
    section.setWorkspace(a);
    section.setActivity({ type: 'activity', id: 'ws-a', items, error: null });
  });

  it('draws the newest turn: a lane for claude and one per subagent, a block per call coloured by kind', () => {
    expect(labels(nav())).toEqual(['Claude', 'reviewer', 'Explore']);
    expect(text('.lane-label title')).toEqual(['Review the diff']);
    expect(nav().querySelectorAll('.track').length).toBe(3);
    // Five calls for claude, two and one for the agents.
    expect(classes('.call')).toEqual([
      'call k-shell failed',
      'call k-edit',
      'call k-web',
      'call k-other',
      'call k-read running',
      'call k-read',
      'call k-read',
      'call k-read running',
    ]);
    expect(text('.call title')[0]).toBe('Bash Bash summary · 10s · failed');
    expect(text('.call title')[4]).toBe('Grep Grep summary · 5s');
    // Each agent is a bracket over the stretch it ran; the one still running is marked.
    expect(classes('.bracket')).toEqual(['bracket', 'bracket running']);
    expect(text('.bracket title')).toEqual(['reviewer: Review the diff · 40s', 'Explore · 30s']);
    expect(nav().querySelectorAll('.axis').length).toBe(2);
    expect(text('.axis')).toEqual(['0s', '1m 30s']);
  });

  it('puts a skill flag on the claude lane, and lays blocks out in time order within the turn', () => {
    [...nav().querySelectorAll<HTMLElement>('.chip')].at(-1)!.click();
    expect(nav().querySelectorAll('.skill-flag').length).toBe(1);
    expect(text('.skill-flag title')).toEqual(['Skill: pest']);
    // The turn ran 100s and its one call began 5s in: 2 for the plot's left edge, plus 5% of its 294 width.
    expect(Number(nav().querySelector('.call')!.getAttribute('x'))).toBeCloseTo(16.7, 1);
    expect(text('.axis')).toEqual(['0s', '1m 40s']);
  });

  it('shows the turns as a strip with the newest selected and the running one marked, and compactions between', () => {
    // Newest first.
    expect(text('.chip-prompt')).toEqual(['now review it', 'fix the bug']);
    expect(classes('.chip')).toEqual(['chip selected running', 'chip']);
    expect(nav().querySelectorAll('.chip-gap').length).toBe(1);
    expect(nav().querySelector('.chip-gap')!.getAttribute('title')).toBe('Context compacted (auto)');
    expect(text('.turn-prompt')).toEqual(['now review it']);
    expect($('activity-state').textContent).toBe('Working');
    expect($('activity-state').classList.contains('running')).toBe(true);
    expect(text('.chart-legend span')).toEqual(['Read / search', 'Edit', 'Shell', 'Web', 'Other', 'Skill']);
  });

  it('draws a picked turn, then goes back to following the newest', () => {
    const chips = () => [...nav().querySelectorAll<HTMLElement>('.chip')].reverse();
    chips()[0].click();
    expect(classes('.chip')).toEqual(['chip running', 'chip selected']);
    expect(text('.turn-prompt')).toEqual(['fix the bug']);
    expect(labels(nav())).toEqual(['Claude']);
    // An update from the helper keeps the pick.
    section.setActivity({ type: 'activity', id: 'ws-a', items, error: null });
    expect(text('.turn-prompt')).toEqual(['fix the bug']);
    chips()[1].click();
    expect(text('.turn-prompt')).toEqual(['now review it']);
    // A pick that has since left the list falls back to the newest.
    chips()[0].click();
    section.setActivity({ type: 'activity', id: 'ws-a', items: [newest], error: null });
    expect(text('.turn-prompt')).toEqual(['now review it']);
    // A new workspace starts on its newest turn.
    chips()[0].click();
    section.setWorkspace(b);
    section.setActivity({ type: 'activity', id: 'ws-b', items, error: null });
    expect(text('.turn-prompt')).toEqual(['now review it']);
  });

  it('keeps the strip where it was scrolled to when it redraws, on a tick and on an update', () => {
    const strip = () => nav().querySelector<HTMLElement>('.chips')!;
    strip().scrollLeft = 120;
    vi.advanceTimersByTime(1000);
    expect(strip().scrollLeft).toBe(120);
    section.setActivity({ type: 'activity', id: 'ws-a', items, error: null });
    expect(strip().scrollLeft).toBe(120);
  });

  it('grows the axis and the running blocks with the clock, and shows Idle once the turn is over', () => {
    vi.advanceTimersByTime(10_000);
    expect(text('.axis')).toEqual(['0s', '1m 40s']);
    expect(text('.call title')[4]).toBe('Grep Grep summary · 15s');
    section.setActivity({ type: 'activity', id: 'ws-a', items: [older, { ...newest, endedAt: at(0) }], error: null });
    expect($('activity-state').textContent).toBe('Idle');
    expect(nav().querySelector('.chip.running')).toBeNull();
  });

  it('labels a turn that began before the lines it has, and a turn with no prompt text on its chip', () => {
    section.setActivity({ type: 'activity', id: 'ws-a', items: [turn('turn-1', '')], error: null });
    expect(text('.turn-prompt')).toEqual(['Earlier in the session']);
    expect(text('.chip-prompt')).toEqual(['Earlier']);
    section.setActivity({ type: 'activity', id: 'ws-a', items: [turn('p9', 'a prompt that is a good deal longer than a chip can hold')], error: null });
    expect(text('.chip-prompt')).toEqual(['a prompt that is …']);
    expect(nav().querySelector('.chip')!.getAttribute('title')).toBe('a prompt that is a good deal longer than a chip can hold');
  });
});

describe('a long turn', () => {
  // Ten minutes in, still running: a call every minute, so the two-minute window holds two.
  const long = turn('p3', 'refactor everything', {
    startedAt: at(600),
    endedAt: null,
    calls: Array.from({ length: 10 }, (_, i) => call(`l${i}`, 'Edit', 590 - i * 60, 585 - i * 60)),
  });

  beforeEach(async () => {
    await make();
    section.setWorkspace(a);
    section.setActivity({ type: 'activity', id: 'ws-a', items: [long], error: null });
    // happy-dom has no layout, so give the chart a width to measure.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 300 } as DOMRect);
  });

  const press = (clientX: number) =>
    nav()
      .querySelector('.chart')!
      .dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX }));
  const move = (clientX: number) => nav().dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX }));
  const release = () => nav().dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));

  it('shows only the trailing two minutes, trailing the clock', () => {
    expect(nav().querySelectorAll('.call').length).toBe(2);
    expect(text('.axis')).toEqual(['8m 0s', '10m 0s']);
    expect(nav().querySelector('.live-button')).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(text('.axis')).toEqual(['9m 0s', '11m 0s']);
  });

  it('is dragged back through the turn, and held there while the clock runs', () => {
    press(100);
    // 300px is two minutes, so 150px back is a minute.
    move(250);
    release();
    expect(text('.axis')).toEqual(['7m 0s', '9m 0s']);
    expect(nav().querySelector('.live-button')).not.toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(text('.axis')).toEqual(['7m 0s', '9m 0s']);
  });

  it('widens and narrows the window with the wheel, around the pointer, and keeps the width when dragged', () => {
    const wheel = (deltaY: number, clientX: number) => {
      // happy-dom's WheelEvent drops the pointer position, so a mouse event carries both.
      const event = new MouseEvent('wheel', { bubbles: true, cancelable: true, clientX });
      Object.defineProperty(event, 'deltaY', { value: deltaY });
      nav().querySelector('.chart')!.dispatchEvent(event);
    };
    // Out at the right edge: the window grows backwards from now. 120s * 1.25 = 150s.
    wheel(100, 300);
    expect(text('.axis')).toEqual(['7m 30s', '10m 0s']);
    expect(nav().querySelector('.live-button')).toBeNull();
    // In at the left edge keeps the left edge where it was: 150s / 1.25 = 120s.
    wheel(-100, 0);
    expect(text('.axis')).toEqual(['7m 30s', '9m 30s']);
    expect(nav().querySelector('.live-button')).not.toBeNull();
    // Dragging keeps the width.
    press(100);
    move(100);
    release();
    expect(text('.axis')).toEqual(['7m 30s', '9m 30s']);
    // It stops at ten seconds, and at the whole turn.
    for (let i = 0; i < 30; i++) wheel(-100, 0);
    expect(text('.axis')).toEqual(['7m 30s', '7m 40s']);
    for (let i = 0; i < 30; i++) wheel(100, 0);
    expect(text('.axis')).toEqual(['0s', '10m 0s']);
  });

  it('goes back to live when a new turn starts while scrubbed back', () => {
    press(100);
    move(250);
    release();
    expect(nav().querySelector('.live-button')).not.toBeNull();
    const next = turn('p4', 'and another', { startedAt: at(300), endedAt: null, calls: [] });
    section.setActivity({ type: 'activity', id: 'ws-a', items: [long, next], error: null });
    expect(text('.turn-prompt')).toEqual(['and another']);
    expect(nav().querySelector('.live-button')).toBeNull();
    expect(text('.axis')).toEqual(['3m 0s', '5m 0s']);
  });

  it('stops at the start of the turn, and goes back to live from the button or by dragging forward', () => {
    press(0);
    move(10_000);
    release();
    expect(text('.axis')).toEqual(['0s', '2m 0s']);
    nav().querySelector<HTMLElement>('.live-button')!.click();
    expect(text('.axis')).toEqual(['8m 0s', '10m 0s']);
    press(0);
    move(300);
    move(0);
    release();
    expect(nav().querySelector('.live-button')).toBeNull();
  });
});

describe('a helper that has not restarted', () => {
  it('draws turns sent without their calls as empty lanes instead of failing', async () => {
    await make();
    section.setWorkspace(a);
    const { calls: _turn, ...bare } = newest;
    const agents = newest.agents.map(({ calls: _agent, ...rest }) => rest) as unknown as ActivityAgent[];
    section.setActivity({ type: 'activity', id: 'ws-a', items: [{ ...bare, agents } as unknown as ActivityTurn], error: null });
    expect(labels(nav())).toEqual(['Claude', 'reviewer', 'Explore']);
    expect(nav().querySelectorAll('.call').length).toBe(0);
    expect(nav().querySelectorAll('.bracket').length).toBe(2);
  });
});
