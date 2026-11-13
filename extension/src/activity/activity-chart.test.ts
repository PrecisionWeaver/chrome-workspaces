// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { ActivityAgent, ActivityCallRecord, ActivityTurn } from '../../../shared/sessions/activity';
import { drawTurn, KIND_LABEL, legend, WIDTH, windowOf, zoomed } from './activity-chart';

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();
const ms = (secondsAgo: number) => NOW - secondsAgo * 1000;

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
const turn = (rest: Partial<ActivityTurn> = {}): ActivityTurn => ({
  kind: 'turn',
  id: 'p1',
  prompt: 'fix the bug',
  startedAt: at(100),
  endedAt: at(10),
  skills: [],
  agents: [],
  tools: [],
  calls: [],
  active: null,
  ...rest,
});

const text = (chart: Element, selector: string) => [...chart.querySelectorAll(selector)].map((node) => node.firstChild?.textContent);
const classes = (chart: Element, selector: string) => [...chart.querySelectorAll(selector)].map((node) => node.getAttribute('class'));
const titles = (chart: Element, selector: string) => [...chart.querySelectorAll(selector)].map((node) => node.querySelector('title')?.textContent);
const x = (node: Element) => Number(node.getAttribute('x'));
const width = (node: Element) => Number(node.getAttribute('width'));

describe('windowOf', () => {
  it('shows a short turn whole, live', () => {
    expect(windowOf(turn(), NOW, null)).toEqual({ from: ms(100), to: ms(10), live: true });
  });

  it('shows the trailing two minutes of a long one, following the clock while it runs', () => {
    const running = turn({ startedAt: at(600), endedAt: null });
    expect(windowOf(running, NOW, null)).toEqual({ from: ms(120), to: NOW, live: true });
    expect(windowOf(running, NOW + 5000, null)).toEqual({ from: ms(115), to: NOW + 5000, live: true });
  });

  it('holds a window dragged back, clamped so it never leaves the turn', () => {
    const long = turn({ startedAt: at(600), endedAt: at(0) });
    expect(windowOf(long, NOW, { end: ms(300) })).toEqual({ from: ms(420), to: ms(300), live: false });
    // Dragged past the start: the window starts at the turn and keeps its width.
    expect(windowOf(long, NOW, { end: ms(590) })).toEqual({ from: ms(600), to: ms(480), live: false });
    // Dragged past the end: it is live again.
    expect(windowOf(long, NOW, { end: ms(-5) })).toEqual({ from: ms(120), to: ms(0), live: true });
  });

  it('honours a chosen width, no narrower than ten seconds and no wider than the turn', () => {
    const long = turn({ startedAt: at(600), endedAt: at(0) });
    expect(windowOf(long, NOW, { end: null, span: 30_000 })).toMatchObject({ from: ms(30), to: ms(0) });
    expect(windowOf(long, NOW, { end: null, span: 1 })).toMatchObject({ from: ms(10) });
    expect(windowOf(long, NOW, { end: null, span: 9_999_999 })).toMatchObject({ from: ms(600) });
  });

  it('gives a turn with no time at all a second, so there is something to draw', () => {
    const instant = turn({ startedAt: at(10), endedAt: at(10) });
    expect(windowOf(instant, NOW, null)).toEqual({ from: ms(10), to: ms(10), live: true });
    expect(windowOf(instant, NOW, { end: ms(10) }).live).toBe(true);
  });
});

describe('zoomed', () => {
  const long = turn({ startedAt: at(600), endedAt: at(0) });

  it('widens or narrows the window by the factor, keeping the moment under the pointer in place', () => {
    const halved = zoomed(long, NOW, { end: ms(300), span: 120_000 }, 0.5, 0.5);
    expect(halved.span).toBe(60_000);
    // The window was 420s..300s ago; its middle, 360s ago, stays in the middle.
    expect(halved.end).toBe(ms(330));
    const doubled = zoomed(long, NOW, { end: ms(300), span: 120_000 }, 2, 0);
    expect(doubled.span).toBe(240_000);
    // Anchored at the left edge, so the window still starts 420s ago.
    expect(doubled.end).toBe(ms(180));
  });

  it('comes back live when widening reaches the end of the turn, and stays put when anchored at the right', () => {
    expect(zoomed(long, NOW, { end: ms(60), span: 120_000 }, 2, 0)).toEqual({ end: null, span: 240_000 });
    expect(zoomed(long, NOW, { end: ms(60), span: 120_000 }, 2, 1)).toEqual({ end: ms(60), span: 240_000 });
  });

  it('stops at ten seconds and at the whole turn', () => {
    expect(zoomed(long, NOW, { end: null, span: 20_000 }, 0.1, 0.5).span).toBe(10_000);
    expect(zoomed(long, NOW, { end: null, span: 400_000 }, 10, 0.5).span).toBe(600_000);
    expect(zoomed(turn({ startedAt: at(5), endedAt: at(0) }), NOW, { end: null }, 10, 0.5).span).toBe(10_000);
  });
});

describe('drawTurn', () => {
  it('draws a lane for claude and one per subagent, each with its calls as blocks coloured by kind', () => {
    const chart = drawTurn(
      turn({
        calls: [
          call('c1', 'Read', 90, 80),
          call('c2', 'Bash', 70, 60),
          call('c3', 'Edit', 50, 40),
          call('c4', 'WebFetch', 35, 30),
          call('c5', 'Agent', 30, 20),
        ],
        agents: [agent('a1', 'Explore', { summary: 'find the bug', calls: [call('c6', 'Grep', 55, 50)] })],
      }),
      NOW,
    );
    expect(chart.getAttribute('viewBox')).toBe(`0 0 ${WIDTH} 76`);
    expect(chart.getAttribute('aria-label')).toBe('Turn timeline');
    expect(text(chart, '.lane-label')).toEqual(['Claude', 'Explore']);
    expect(titles(chart, '.lane-label')).toEqual([undefined, 'find the bug']);
    expect(chart.querySelectorAll('.track')).toHaveLength(2);
    expect(classes(chart, '.call')).toEqual(['call k-read', 'call k-shell', 'call k-edit', 'call k-web', 'call k-other', 'call k-read']);
    expect(titles(chart, '.call')[0]).toBe('Read Read summary · 10s');
    expect(classes(chart, '.bracket')).toEqual(['bracket']);
    expect(titles(chart, '.bracket')).toEqual(['Explore: find the bug · 40s']);
  });

  it('lays the blocks out in time order and labels the axis from the start of the turn', () => {
    const chart = drawTurn(turn({ calls: [call('c1', 'Read', 90, 80), call('c2', 'Bash', 50, 40)] }), NOW);
    expect(text(chart, '.axis')).toEqual(['0s', '1m 30s']);
    const [first, second] = [...chart.querySelectorAll('.call')];
    expect(x(first!)).toBeLessThan(x(second!));
    expect(x(first!) + width(first!)).toBeLessThanOrEqual(x(second!));
  });

  it('marks a running call and a running subagent, outlines a failed call, and never draws a block too thin to see', () => {
    const chart = drawTurn(
      turn({
        endedAt: null,
        calls: [call('c1', 'Bash', 50, 50, { failed: true }), call('c2', 'Read', 5, null)],
        agents: [agent('a1', 'Plan', { startedAt: at(30), endedAt: null })],
      }),
      NOW,
    );
    expect(classes(chart, '.call')).toEqual(['call k-shell failed', 'call k-read running']);
    expect(titles(chart, '.call')).toEqual(['Bash Bash summary · 0s · failed', 'Read Read summary · 5s']);
    expect(width(chart.querySelector('.call')!)).toBe(2);
    expect(classes(chart, '.bracket')).toEqual(['bracket running']);
    expect(text(chart, '.axis')).toEqual(['0s', '1m 40s']);
  });

  it('puts skill flags on claude’s lane only', () => {
    const chart = drawTurn(turn({ skills: [{ name: 'pest', at: at(80) }], agents: [agent('a1', 'Explore')] }), NOW);
    expect(titles(chart, '.skill-flag')).toEqual(['Skill: pest']);
    const flag = chart.querySelector('.skill-flag')!;
    const claudeTrack = chart.querySelector('.track')!;
    expect(flag.getAttribute('d')).toContain(`${Number(claudeTrack.getAttribute('y')) - 1} `);
  });

  it('draws only what falls inside the window, and starts the axis where the window does', () => {
    const long = turn({
      startedAt: at(600),
      endedAt: at(0),
      calls: [call('c1', 'Read', 500, 490), call('c2', 'Bash', 100, 90)],
      skills: [
        { name: 'early', at: at(550) },
        { name: 'late', at: at(50) },
      ],
      agents: [agent('a1', 'Old', { startedAt: at(580), endedAt: at(500) }), agent('a2', 'Recent', { startedAt: at(200), endedAt: at(90) })],
    });
    const chart = drawTurn(long, NOW);
    expect(text(chart, '.axis')).toEqual(['8m 0s', '10m 0s']);
    expect(classes(chart, '.call')).toEqual(['call k-shell']);
    expect(titles(chart, '.skill-flag')).toEqual(['Skill: late']);
    // Every subagent keeps its lane; only the one that ran inside the window has a bracket, clipped to the window's edge.
    expect(text(chart, '.lane-label')).toEqual(['Claude', 'Old', 'Recent']);
    expect(chart.querySelectorAll('.bracket')).toHaveLength(1);
    expect(x(chart.querySelector('.bracket')!)).toBe(2);
  });

  it('draws turns from a helper that sends no calls as empty lanes', () => {
    const bare = turn({ agents: [agent('a1', 'Explore')] });
    delete (bare as Partial<ActivityTurn>).calls;
    delete (bare.agents[0] as Partial<ActivityAgent>).calls;
    const chart = drawTurn(bare, NOW);
    expect(text(chart, '.lane-label')).toEqual(['Claude', 'Explore']);
    expect(chart.querySelectorAll('.call')).toHaveLength(0);
  });
});

describe('legend', () => {
  it('names every kind of block, and the skill flag', () => {
    const box = legend();
    expect(box.className).toBe('chart-legend');
    expect([...box.querySelectorAll('span')].map((item) => item.textContent)).toEqual([...Object.values(KIND_LABEL), 'Skill']);
    expect([...box.querySelectorAll('i')].map((swatch) => swatch.className)).toEqual([
      'legend-swatch k-read',
      'legend-swatch k-edit',
      'legend-swatch k-shell',
      'legend-swatch k-web',
      'legend-swatch k-other',
      'legend-swatch skill',
    ]);
  });
});
