import type { SystemSnapshot } from '../../shared/protocol';
import { combineHistory, topConsumers } from '../../shared/resources';
import { el, hoverTip } from './dom';
import { formatCpu, formatKb, resourceTotal } from './format';
import { row } from './settings-parts';
import { MIN_POINTS } from './sparkline';

/** Workspaces listed under the chart before the rest are left to the rows below. */
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

/**
 * Every running workspace's memory and CPU together over the last couple of hours, from the samples the helper already keeps,
 * at the top of the Workspaces card: the totals, the chart, and the three workspaces using the most memory.
 * Nothing while no workspace runs; a note stands in for the chart until there are enough samples to draw.
 */
export function resourcesChart(s: SystemSnapshot): HTMLElement[] {
  const running = s.sessions.filter((x) => x.pid !== null).length;
  if (running === 0) return [];
  const samples = combineHistory(s.sessions);
  // The same total as the Total line below: the helper's own use plus every workspace's.
  const { kb, cpu: totalCpu } = resourceTotal(s);

  const headline = el('div', '', 'usage-headline');
  headline.append(
    el('span', formatKb(kb), 'usage-cost'),
    el('span', `${formatCpu(totalCpu)} CPU`, 'usage-tokens'),
    el('span', `across ${running} running workspace${running === 1 ? '' : 's'} and the helper`, 'usage-change'),
  );
  const top = el('div', '', 'resources-top');
  top.append(...topConsumers(s.sessions, CONSUMER_ROWS).map((c) => row(c.name, `${formatKb(c.rssKb)} · ${formatCpu(c.cpu)}`)));

  if (samples.length < MIN_POINTS) {
    return [headline, el('p', 'Collecting samples; the chart appears in a few minutes.', 'settings-note'), top];
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

  legend.title = 'The running workspaces added up, one sample a minute for up to two hours; each line is scaled to its own peak.';

  return [headline, chart, axis, legend, top];
}
