import type { SystemSnapshot } from '../../shared/protocol';
import { combineHistory, topConsumers } from '../../shared/resources';
import { el, hoverTip } from './dom';
import { formatCpu, formatKb, resourceTotal } from './format';
import { MIN_POINTS } from './sparkline';
import { card, row } from './settings-parts';

/** Workspaces listed under the chart before the rest are left to the sessions card. */
const CONSUMER_ROWS = 3;

const NS = 'http://www.w3.org/2000/svg';

const clock = (t: number): string => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** A series as polyline points across the chart, from the floor to its own peak, so memory and CPU are each read against themselves. */
function line(values: readonly number[], peak: number, className: string): SVGPolylineElement {
  const poly = document.createElementNS(NS, 'polyline');
  poly.setAttribute('class', className);
  poly.setAttribute(
    'points',
    values.map((v, i) => `${(((i + 0.5) / values.length) * 100).toFixed(2)},${(100 - (peak > 0 ? (v / peak) * 96 : 0) - 2).toFixed(2)}`).join(' '),
  );
  return poly;
}

/** Every running workspace's memory and CPU together over the last couple of hours, from the samples the helper already keeps. */
export function resourcesCard(s: SystemSnapshot): HTMLElement {
  const running = s.sessions.filter((x) => x.pid !== null).length;
  const samples = combineHistory(s.sessions);
  const { workspaceKb, workspaceCpu } = resourceTotal(s);

  const headline = el('div', '', 'usage-headline');
  headline.append(
    el('span', formatKb(workspaceKb), 'usage-cost'),
    el('span', `${formatCpu(workspaceCpu)} CPU`, 'usage-tokens'),
    el('span', `across ${running} running workspace${running === 1 ? '' : 's'}`, 'usage-change'),
  );

  const consumers = topConsumers(s.sessions, CONSUMER_ROWS).map((c) => row(c.name, `${formatKb(c.rssKb)} · ${formatCpu(c.cpu)}`));

  if (samples.length < MIN_POINTS) {
    return card(
      'Resources',
      headline,
      ...consumers,
      el('p', 'Collecting samples. The chart appears after a few minutes of a workspace running; the helper samples once a minute.', 'settings-note'),
    );
  }

  const memory = samples.map((p) => p.rssKb);
  const cpu = samples.map((p) => p.cpu);
  const peakMemory = Math.max(...memory);
  const peakCpu = Math.max(...cpu);

  const chart = el('div', '', 'resources-chart');
  const plot = document.createElementNS(NS, 'svg');
  plot.setAttribute('class', 'resources-lines');
  plot.setAttribute('viewBox', '0 0 100 100');
  plot.setAttribute('preserveAspectRatio', 'none');
  plot.setAttribute('aria-hidden', 'true');
  // CPU first, so memory is drawn over it.
  plot.append(line(cpu, peakCpu, 'cpu'), line(memory, peakMemory, 'mem'));
  chart.append(plot);
  const columns = el('div', '', 'resources-columns');
  for (const p of samples) {
    const column = el('div', '', 'resources-column');
    hoverTip(column, `${clock(p.t)}\nMemory ${formatKb(p.rssKb)}\nCPU ${formatCpu(p.cpu)}\n${p.sessions} workspace${p.sessions === 1 ? '' : 's'}`);
    columns.append(column);
  }
  chart.append(columns);

  const minutes = Math.max(1, Math.round((samples[samples.length - 1].t - samples[0].t) / 60_000));
  const span = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const axis = el('div', '', 'usage-axis');
  axis.append(el('span', `${span} ago`), el('span', `peak ${formatKb(peakMemory)} · ${formatCpu(peakCpu)}`), el('span', 'now'));

  const legend = el('div', '', 'resources-legend');
  const key = (className: string, text: string) => {
    const item = el('span');
    item.append(el('i', '', `resources-swatch ${className}`), text);
    return item;
  };
  legend.append(key('mem', 'Memory'), key('cpu', 'CPU'));

  return card(
    'Resources',
    headline,
    chart,
    axis,
    legend,
    ...consumers,
    el(
      'p',
      `Running workspaces added together, one sample a minute for up to two hours; each line is scaled to its own peak. It counts only what claude sessions use (the helper is ${formatKb(s.helper.rssKb)} on top), not the rest of the machine, and moves as workspaces start and stop. CPU is a percentage of one core, so it can pass 100.`,
      'settings-note',
    ),
  );
}
