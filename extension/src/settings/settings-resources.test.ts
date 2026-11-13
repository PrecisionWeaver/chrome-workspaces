// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { SystemSession } from '../../../shared/protocol/protocol';
import { makeSession, makeSnapshot } from '../../testing/fixtures';
import { resourcesChart } from './settings-resources';

const sample = (i: number, rssKb: number, cpu: number) => ({ t: 1_000_000 + i * 60_000, rssKb, cpu });
const running = (id: string, name: string, history: ReturnType<typeof sample>[], rssKb = 100_000, cpu = 2): SystemSession =>
  makeSession({ id, name, pid: 10, history, processes: [{ pid: 10, ppid: 1, command: 'claude', cpu, rssKb, elapsed: '01:00', ports: [] }] });
const classes = (nodes: HTMLElement[]) => nodes.map((n) => n.className);

describe('resourcesChart', () => {
  it('draws nothing while no workspace runs', () => {
    expect(resourcesChart(makeSnapshot({ sessions: [] }))).toEqual([]);
    expect(resourcesChart(makeSnapshot({ sessions: [makeSession({ pid: null, processes: [] })] }))).toEqual([]);
  });

  it('totals the helper and the running workspaces in the headline, with the count', () => {
    const one = resourcesChart(makeSnapshot({ sessions: [running('ws-a', 'acme/app', [])] }));
    expect([...one[0]!.querySelectorAll('span')].map((n) => n.textContent)).toEqual(['147.7 MB', '3.5% CPU', 'across 1 running workspace and the helper']);
    const two = resourcesChart(makeSnapshot({ sessions: [running('ws-a', 'acme/app', []), running('ws-b', 'acme/api', [])] }));
    expect(two[0]!.querySelectorAll('span')[2]!.textContent).toBe('across 2 running workspaces and the helper');
  });

  it('stands a note in for the chart until there are enough samples, keeping the top consumers', () => {
    const nodes = resourcesChart(makeSnapshot({ sessions: [running('ws-a', 'acme/app', [sample(0, 1000, 1), sample(1, 1000, 1)])] }));
    expect(classes(nodes)).toEqual(['usage-headline', 'settings-note', 'resources-top']);
    expect(nodes[1]!.textContent).toBe('Collecting samples; the chart appears in a few minutes.');
  });

  it('lists the three workspaces using the most memory, biggest first', () => {
    const sessions = [
      running('ws-1', 'acme/one', [], 1000),
      running('ws-2', 'acme/two', [], 4000),
      running('ws-3', 'acme/three', [], 3000),
      running('ws-4', 'acme/four', [], 2000),
    ];
    const top = resourcesChart(makeSnapshot({ sessions })).at(-1)!;
    expect(top.className).toBe('resources-top');
    expect([...top.querySelectorAll('.kv .k')].map((n) => n.textContent)).toEqual(['acme/two', 'acme/three', 'acme/four']);
    expect(top.querySelector('.kv .v')!.textContent).toBe('3.9 MB · 2.0%');
  });

  describe('with enough samples', () => {
    const sessions = [
      running('ws-a', 'acme/app', [sample(0, 100_000, 10), sample(1, 200_000, 20), sample(2, 300_000, 30)]),
      running('ws-b', 'acme/api', [sample(0, 100_000, 10), sample(1, 100_000, 10), sample(2, 100_000, 10)]),
    ];

    it('is the headline, the chart, its axis, the legend and the top consumers', () => {
      expect(classes(resourcesChart(makeSnapshot({ sessions })))).toEqual([
        'usage-headline',
        'resources-chart',
        'usage-axis',
        'resources-legend',
        'resources-top',
      ]);
    });

    it('scales memory and CPU each to its own peak, drawing CPU first so memory sits on top', () => {
      const chart = resourcesChart(makeSnapshot({ sessions }))[1]!;
      const lines = [...chart.querySelectorAll('polyline')];
      expect(lines.map((l) => l.getAttribute('class'))).toEqual(['cpu', 'mem']);
      // Combined per minute: memory 200, 300, 400 MB (peak 400) and CPU 20, 30, 40 (peak 40), so both lines climb alike.
      expect(lines[0]!.getAttribute('points')).toBe('16.67,50.00 50.00,26.00 83.33,2.00');
      expect(lines[1]!.getAttribute('points')).toBe('16.67,50.00 50.00,26.00 83.33,2.00');
      expect(chart.querySelector('svg')!.getAttribute('preserveAspectRatio')).toBe('none');
    });

    it('sits a line on the floor when its peak is zero', () => {
      const idle = [running('ws-a', 'acme/app', [sample(0, 1000, 0), sample(1, 1000, 0), sample(2, 1000, 0)])];
      const chart = resourcesChart(makeSnapshot({ sessions: idle }))[1]!;
      expect(chart.querySelector('.cpu')!.getAttribute('points')).toBe('16.67,98.00 50.00,98.00 83.33,98.00');
    });

    it('gives each minute a column with the totals of that minute in its tip', () => {
      const chart = resourcesChart(makeSnapshot({ sessions }))[1]!;
      const columns = [...chart.querySelectorAll<HTMLElement>('.resources-column')];
      expect(columns).toHaveLength(3);
      expect(columns[1]!.dataset.tip).toMatch(/^\d{2}:\d{2} [AP]M\nMemory 293\.0 MB\nCPU 30\.0%\n2 workspaces$/);
    });

    it('labels the axis with how far back the samples go, and the peaks', () => {
      expect([...resourcesChart(makeSnapshot({ sessions }))[2]!.querySelectorAll('span')].map((n) => n.textContent)).toEqual([
        '2m ago',
        'peak 390.6 MB · 40.0%',
        'now',
      ]);
    });

    it('reads a long span in hours and minutes', () => {
      const long = [
        running(
          'ws-a',
          'acme/app',
          Array.from({ length: 66 }, (_, i) => sample(i, 1000, 1)),
        ),
      ];
      expect(resourcesChart(makeSnapshot({ sessions: long }))[2]!.querySelector('span')!.textContent).toBe('1h 5m ago');
    });

    it('keys the legend to the two lines, and explains the chart in its title', () => {
      const legend = resourcesChart(makeSnapshot({ sessions }))[3]!;
      expect([...legend.querySelectorAll('span')].map((n) => n.textContent)).toEqual(['Memory', 'CPU']);
      expect([...legend.querySelectorAll('i')].map((n) => n.className)).toEqual(['resources-swatch mem', 'resources-swatch cpu']);
      expect(legend.title).toContain('scaled to its own peak');
    });
  });
});
