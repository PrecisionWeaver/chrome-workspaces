import type { ActivityCallRecord, ActivityTurn } from '../../shared/activity';
import { formatDuration } from './format';

export type CallKind = 'read' | 'edit' | 'shell' | 'web' | 'other';

const KINDS: Record<string, CallKind> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  LS: 'read',
  Edit: 'edit',
  Write: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Bash: 'shell',
  WebFetch: 'web',
  WebSearch: 'web',
};

export const kindOf = (tool: string): CallKind => KINDS[tool] ?? 'other';

export const KIND_LABEL: Record<CallKind, string> = { read: 'Read / search', edit: 'Edit', shell: 'Shell', web: 'Web', other: 'Other' };

/** The drawing's own size in viewBox units; it scales to the width of the list. */
export const WIDTH = 300;
const LANE_HEIGHT = 14;

const AXIS = 14;
const LABEL = 12;
const GAP = 5;
const MIN_BLOCK = 2;

const NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, className = ''): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (className) node.setAttribute('class', className);
  return node;
}
const title = (parent: Element, text: string): void => {
  const node = svg('title');
  node.textContent = text;
  parent.append(node);
};

const seconds = (from: number, to: number) => formatDuration(Math.max(0, Math.round((to - from) / 1000)));

interface Lane {
  label: string;
  detail: string;
  calls: ActivityCallRecord[];
  /** Set for a subagent: the stretch it was running. */
  span?: { from: number; to: number | null };
}

/**
 * One turn as a swimlane: a lane for claude and one for each subagent, time running left to right. A tool call is
 * a block coloured by its kind; a subagent is a bracket over the stretch it ran, with its own calls inside, so two
 * running together sit one above the other. A running call pulses, a failed one is outlined red, and a skill is a flag.
 */
export function drawTurn(turn: ActivityTurn, now: number): SVGSVGElement {
  const start = Date.parse(turn.startedAt);
  const end = turn.endedAt ? Date.parse(turn.endedAt) : now;
  const duration = Math.max(end - start, 1000);
  const lanes: Lane[] = [
    // A helper older than the panel sends turns without their calls; they draw as empty lanes until it restarts.
    { label: 'Claude', detail: '', calls: turn.calls ?? [] },
    ...turn.agents.map((a) => ({
      label: a.type,
      detail: a.summary,
      calls: a.calls ?? [],
      span: { from: Date.parse(a.startedAt), to: a.endedAt ? Date.parse(a.endedAt) : null },
    })),
  ];

  const left = 2;
  const plot = WIDTH - left - 4;
  const x = (time: number) => left + (Math.min(Math.max(time, start), start + duration) - start) * (plot / duration);
  const row = LANE_HEIGHT + LABEL + GAP;
  const height = AXIS + lanes.length * row;

  const chart = svg('svg', { viewBox: `0 0 ${WIDTH} ${height}`, role: 'img', 'aria-label': 'Turn timeline' }, 'chart');
  chart.append(svg('text', { x: left, y: 9 }, 'axis'), svg('text', { x: WIDTH - 4, y: 9, 'text-anchor': 'end' }, 'axis'));
  chart.children[0].textContent = '0s';
  chart.children[1].textContent = seconds(start, end);

  lanes.forEach((lane, index) => {
    const top = AXIS + index * row;
    const trackY = top + LABEL;
    const label = svg('text', { x: left, y: top + 9 }, 'lane-label');
    label.textContent = lane.label;
    if (lane.detail) title(label, lane.detail);
    chart.append(label);
    chart.append(svg('rect', { x: left, y: trackY, width: plot, height: LANE_HEIGHT, rx: 2 }, 'track'));

    if (lane.span) {
      const from = x(lane.span.from);
      const to = x(lane.span.to ?? now);
      const bracket = svg(
        'rect',
        { x: from, y: trackY, width: Math.max(to - from, MIN_BLOCK), height: LANE_HEIGHT, rx: 2 },
        `bracket${lane.span.to ? '' : ' running'}`,
      );
      title(bracket, `${lane.label}${lane.detail ? `: ${lane.detail}` : ''} · ${seconds(lane.span.from, lane.span.to ?? now)}`);
      chart.append(bracket);
    }

    for (const call of lane.calls) {
      const from = x(Date.parse(call.at));
      const to = x(call.endedAt ? Date.parse(call.endedAt) : now);
      const block = svg(
        'rect',
        { x: from, y: trackY + 2, width: Math.max(to - from, MIN_BLOCK), height: LANE_HEIGHT - 4, rx: 1.5 },
        `call k-${kindOf(call.tool)}${call.endedAt ? '' : ' running'}${call.failed ? ' failed' : ''}`,
      );
      title(
        block,
        `${call.tool}${call.summary ? ` ${call.summary}` : ''} · ${seconds(Date.parse(call.at), call.endedAt ? Date.parse(call.endedAt) : now)}${call.failed ? ' · failed' : ''}`,
      );
      chart.append(block);
    }

    // Skills are claude's, so their flags stand on its lane.
    if (index === 0) {
      for (const skill of turn.skills) {
        const at = x(Date.parse(skill.at));
        const flag = svg('path', { d: `M${at} ${trackY - 1} l6 3.5 l-6 3.5 z` }, 'skill-flag');
        title(flag, `Skill: ${skill.name}`);
        chart.append(flag);
      }
    }
  });
  return chart;
}

/** What each colour is, for the kinds drawn. */
export function legend(): HTMLElement {
  const box = document.createElement('div');
  box.className = 'chart-legend';
  for (const kind of Object.keys(KIND_LABEL) as CallKind[]) {
    const item = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.className = `swatch k-${kind}`;
    item.append(swatch, KIND_LABEL[kind]);
    box.append(item);
  }
  const skill = document.createElement('span');
  const flag = document.createElement('i');
  flag.className = 'swatch skill';
  skill.append(flag, 'Skill');
  box.append(skill);
  return box;
}
