import type { TimelineEvent } from '../../../shared/sessions/timeline';
import { statusLabel } from '../../../shared/workspaces/attention';
import { formatUsd } from '../../../shared/usage/pricing';
import type { SystemProcess, SystemSession, SystemSnapshot, TokenTotals } from '../../../shared/protocol/protocol';
import { caret, el } from '../ui/dom';
import { formatCpu, formatKb, formatTokens, newTokens, resourceTitle, resourceTotal } from '../ui/format';
import { card, guarded, type SettingsContext, shortId } from './settings-parts';
import { resourcesChart } from './settings-resources';
import { resourceChart } from '../ui/sparkline';

/** What the Workspaces card remembers between redraws. */
export interface SessionsState {
  /** Sessions whose process list is open. */
  expanded: Set<string>;
  /** Where each session's process list was scrolled to, put back after every redraw. */
  procScroll: Map<string, number>;
  /** Sessions whose activity list is open, and what each last returned. */
  activityOpen: Set<string>;
  activity: Map<string, { events: TimelineEvent[]; error: string | null }>;
}

export const newSessionsState = (): SessionsState => ({
  expanded: new Set(),
  procScroll: new Map(),
  activityOpen: new Set(),
  activity: new Map(),
});

const tokenBreakdown = (t: TokenTotals): string =>
  `input ${t.input.toLocaleString()} · output ${t.output.toLocaleString()} · cache written ${t.cacheWrite.toLocaleString()} · cache read ${t.cacheRead.toLocaleString()}`;

const clock = (iso: string): string =>
  iso
    ? new Date(iso).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '';
const KIND_LABEL = { you: 'You', said: 'Claude', tool: '' } as const;

function processRow(ctx: SettingsContext, session: SystemSession, proc: SystemProcess, isShell: boolean): HTMLElement {
  const line = el('div', '', `proc${isShell ? ' shell' : ''}`);
  line.append(el('span', String(proc.pid), 'pid'), el('span', proc.command, 'cmd'));
  line.title = proc.command;
  const meta = el('span', '', 'proc-meta');
  for (const port of proc.ports) {
    const chip = el('button', `:${port}`, 'port');
    chip.type = 'button';
    chip.title = `Open localhost:${port}`;
    chip.addEventListener('click', () => void chrome.tabs.create({ url: `http://localhost:${port}` }));
    meta.append(chip);
  }
  meta.append(el('span', formatCpu(proc.cpu), 'num'), el('span', formatKb(proc.rssKb), 'num'), el('span', proc.elapsed, 'num'));
  line.append(meta);
  if (!isShell) {
    const kill = el('span', '', 'proc-actions');
    kill.append(
      guarded(ctx, `stop-${proc.pid}`, 'Stop', 'Stop it and its children?', () => ctx.request({ action: 'killProcess', id: session.id, pid: proc.pid })),
      guarded(
        ctx,
        `kill-${proc.pid}`,
        'Force',
        'Force kill (SIGKILL)?',
        () =>
          ctx.request({
            action: 'killProcess',
            id: session.id,
            pid: proc.pid,
            force: true,
          }),
        {
          danger: true,
        },
      ),
    );
    line.append(kill);
  }
  return line;
}

/** What a session has recently done: the files it changed, then each event with its time, newest first. */
function activityList(state: SessionsState, session: SystemSession): HTMLElement {
  const found = state.activity.get(session.id);
  if (!found) return el('div', 'Loading…', 'activity');
  if (found.error) return el('div', found.error, 'activity');
  if (found.events.length === 0) return el('div', 'Nothing yet.', 'activity');

  const box = el('div', '', 'activity');
  const changed = [...new Set(found.events.flatMap((e) => (e.kind === 'tool' && e.file && e.tool !== 'Read' ? [e.file] : [])))];
  if (changed.length) {
    const files = el('div', '', 'activity-files');
    files.append(el('span', `Changed ${changed.length} file${changed.length === 1 ? '' : 's'}: `, 'k'));
    files.append(el('span', changed.map((f) => f.split('/').pop()).join(', '), 'v'));
    files.title = changed.join('\n');
    box.append(files);
  }
  for (const event of [...found.events].reverse()) {
    const line = el('div', '', `activity-row ${event.kind}`);
    line.append(
      el('span', clock(event.at), 'activity-time'),
      el('span', event.kind === 'tool' ? event.tool : KIND_LABEL[event.kind], 'activity-kind'),
      el('span', event.summary, 'activity-text'),
    );
    line.title = event.summary;
    box.append(line);
  }
  return box;
}

/** Memory and CPU lately, as one small chart; null until a session has been sampled a few times. */
function trendChart(session: SystemSession, warnMb: number): HTMLElement | null {
  const { history } = session;
  const rss = history.map((h) => h.rssKb);
  const cpu = history.map((h) => h.cpu);
  const chart = resourceChart(rss, cpu, (history.at(-1)?.rssKb ?? 0) / 1024 >= warnMb ? 'warn' : '');
  if (!chart) return null;
  const minutes = Math.round((history[history.length - 1].t - history[0].t) / 60_000);
  const span = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  const node = el('span', '', 'session-trend');
  node.title = [
    `Over the last ${span}`,
    `Memory: ${formatKb(rss[rss.length - 1])} now, peak ${formatKb(Math.max(...rss))}`,
    `CPU: ${cpu[cpu.length - 1].toFixed(1)}% now, peak ${Math.max(...cpu).toFixed(1)}%`,
  ].join('\n');
  node.append(chart);
  return node;
}

function sessionRow(ctx: SettingsContext, state: SessionsState, session: SystemSession, warnMb: number): HTMLElement {
  const running = session.pid !== null;
  const open = state.expanded.has(session.id) && running;
  const wrapper = el('div', '', 'session');

  const head = el('div', '', 'session-head');
  const toggle = el('button', '', 'session-toggle');
  if (running) toggle.append(caret(open));
  toggle.type = 'button';
  toggle.disabled = !running;
  toggle.addEventListener('click', () => {
    if (open) state.expanded.delete(session.id);
    else state.expanded.add(session.id);
    ctx.render();
  });
  const memory = session.processes.reduce((sum, p) => sum + p.rssKb, 0);
  const cpu = session.processes.reduce((sum, p) => sum + p.cpu, 0);
  const ports = session.processes.flatMap((p) => p.ports);
  const summary = el('span', '', 'session-summary');
  summary.append(el('span', session.name, 'session-name'));
  if (session.status && running) summary.append(el('span', statusLabel(session.status, null), `session-chip ${session.status}`));
  if (session.cwdMissing) summary.append(el('span', 'directory missing', 'session-chip bad'));
  if (session.tokens) {
    const cost = session.tokens.costUsd > 0 ? ` · ~${formatUsd(session.tokens.costUsd)}` : '';
    const tokens = el('span', session.tokens.counting ? 'counting tokens…' : `${formatTokens(newTokens(session.tokens))} tokens${cost}`, 'session-tokens');
    tokens.title = `${tokenBreakdown(session.tokens)}\nCache reads are repeats of earlier input, so they are not in the headline figure.${cost ? '\nThe dollar figure is an estimate, using the rates under "pricing" in the config.' : ''}`;
    summary.append(tokens);
  }
  summary.title = session.cwd;
  // The usage is a right-aligned column, like the amounts on a bill; the trend chart stays with the name.
  const trend = running ? trendChart(session, warnMb) : null;
  if (trend) summary.append(trend);
  const usage = el(
    'span',
    running ? `${formatKb(memory)} · ${formatCpu(cpu)}${ports.length ? ` · ${ports.map((p) => `:${p}`).join(' ')}` : ''}` : 'not running',
    'session-detail',
  );
  usage.classList.add('session-usage');
  head.append(toggle, summary, usage);
  wrapper.append(head);
  if (!open) return wrapper;

  // A fixed box, so processes starting and stopping do not move what is below; a long list scrolls inside it.
  const list = el('div', '', 'procs fixed');
  list.dataset.session = session.id;
  list.addEventListener('scroll', () => state.procScroll.set(session.id, list.scrollTop));
  list.append(...session.processes.map((proc, index) => processRow(ctx, session, proc, index === 0)));
  wrapper.append(list);

  const shown = state.activityOpen.has(session.id);
  // A quiet toggle in line with the process list and activity box it belongs to, not a button of its own.
  const link = el('button', '', 'session-link');
  link.type = 'button';
  link.title = "What this session's claude has recently done";
  link.setAttribute('aria-expanded', String(shown));
  link.append(caret(shown), shown ? 'Hide activity' : 'Show activity');
  link.addEventListener('click', () => {
    if (shown) state.activityOpen.delete(session.id);
    else {
      state.activityOpen.add(session.id);
      ctx.send({ type: 'timeline', id: session.id });
    }
    ctx.render();
  });
  const line = el('div', '', 'session-actions');
  line.append(link);
  const { claudeSessionId } = session;
  if (claudeSessionId) {
    // The id is what `claude --resume` takes, so it is a click away.
    const copy = el('button', `Session ${shortId(claudeSessionId)}`, 'session-link');
    copy.type = 'button';
    copy.title = `Copy ${claudeSessionId}`;
    copy.addEventListener('click', () => {
      void navigator.clipboard.writeText(claudeSessionId);
      ctx.showResult({ ok: true, message: 'Session id copied.' });
    });
    line.append(copy);
  }
  // The activity and session links stay left; the process count and Restart are pushed to the far right.
  line.append(
    el('span', `${session.processes.length} process${session.processes.length === 1 ? '' : 'es'}`, 'session-count'),
    guarded(ctx, `restart-${session.id}`, 'Restart', 'End its shell?', () => ctx.request({ action: 'restartSession', id: session.id })),
  );
  wrapper.append(line);
  if (shown) wrapper.append(activityList(state, session));
  return wrapper;
}

function memoryLine(label: string, kb: number, cpu: number | undefined, title: string, className = ''): HTMLElement {
  const line = el('div', '', `memory-line${className ? ` ${className}` : ''}`);
  line.append(el('span', label, 'k'), el('span', `${formatKb(kb)} · ${formatCpu(cpu)}`, 'v'));
  line.title = title;
  return line;
}

/** Every workspace's session: the running ones' memory and CPU charted together on top, then each with its processes. */
export function workspacesCard(ctx: SettingsContext, state: SessionsState, s: SystemSnapshot): HTMLElement {
  const running = s.sessions.filter((x) => x.pid !== null).length;
  const counted = s.sessions.flatMap((x) => (x.tokens && !x.tokens.counting ? [x.tokens] : []));
  const total = counted.reduce((sum, t) => sum + newTokens(t), 0);
  const { kb, cpu } = resourceTotal(s);
  const list = el('div', '', 'sessions');
  // Running workspaces first, since those are the ones using the machine.
  const warnMb = s.config.limits.memoryWarnMb;
  list.append(...[...s.sessions].sort((a, b) => Number(b.pid !== null) - Number(a.pid !== null)).map((x) => sessionRow(ctx, state, x, warnMb)));
  if (s.sessions.length === 0) list.append(el('div', 'No workspaces yet.', 'settings-empty'));
  return card(
    `Workspaces · ${running} running${counted.length ? ` · ${formatTokens(total)} tokens` : ''}`,
    ...resourcesChart(s),
    list,
    memoryLine('Helper', s.helper.rssKb, s.helper.cpu, 'The helper process that runs these sessions'),
    // RSS counts shared pages once per process, so the total runs a little high.
    memoryLine('Total', kb, cpu, resourceTitle(s), 'memory-total'),
  );
}
