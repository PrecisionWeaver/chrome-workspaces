import type { SystemSnapshot } from '../../shared/protocol';
import { resetLabel } from '../../shared/plan-usage';
import { formatUsd } from '../../shared/pricing';
import { previousLabel, shortDay, summarizeUsage, USAGE_RANGES, usageChange } from '../../shared/usage';
import { el } from './dom';
import { formatTokens } from './format';
import type { Prefs } from './prefs';
import { card, row } from './settings-parts';

type UsageRangeId = Prefs['usageRange'];

/** Models listed under the usage figures before the rest are folded into a count. */
const MODEL_ROWS = 5;

function rangePicker(current: UsageRangeId, onChange: (id: UsageRangeId) => void): HTMLElement {
  const picker = el('div', '', 'usage-range');
  picker.setAttribute('role', 'group');
  picker.setAttribute('aria-label', 'Usage range');
  for (const { id, label } of USAGE_RANGES) {
    const active = id === current;
    const button = el('button', label, `usage-range-btn${active ? ' active' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-pressed', String(active));
    button.addEventListener('click', () => {
      if (id !== current) onChange(id);
    });
    picker.append(button);
  }
  return picker;
}

const dayFigures = (tokens: number, costUsd: number): string => `${formatTokens(tokens)} tokens${costUsd > 0 ? ` · ~${formatUsd(costUsd)}` : ''}`;

/** The plan's session and weekly limits, as `/usage` shows them, from what claude last told a workspace's status line. */
export function planCard(s: SystemSnapshot): HTMLElement {
  const now = Date.parse(s.takenAt);
  const { limits, updatedAt } = s.plan;
  if (!limits.length) {
    return card(
      'Plan usage',
      el(
        'p',
        'No figures yet. claude reports them to a workspace after its first reply, for Pro and Max plans, so open a workspace and send a message. Sessions started outside this app are not counted.',
        'settings-note',
      ),
    );
  }
  const meters = limits.map((limit) => {
    const level = limit.percent >= 90 ? ' bad' : limit.percent >= 70 ? ' warn' : '';
    const line = el('div', '', 'plan-limit');
    const head = el('div', '', 'plan-limit-head');
    head.append(el('span', limit.label, 'plan-limit-label'), el('span', `${Math.round(limit.percent)}% used`, 'plan-limit-percent'));
    const bar = el('div', '', `plan-meter${level}`);
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', limit.label);
    bar.setAttribute('aria-valuenow', String(Math.round(limit.percent)));
    const fill = el('span', '', 'plan-meter-fill');
    fill.style.width = `${Math.min(100, limit.percent)}%`;
    bar.append(fill);
    line.append(head, bar, el('div', resetLabel(limit.resetsAt, now), 'plan-limit-reset'));
    return line;
  });
  const age = updatedAt ? Math.max(0, Math.round((now - Date.parse(updatedAt)) / 60_000)) : null;
  return card(
    'Plan usage',
    ...meters,
    el(
      'p',
      `${age === null ? '' : age < 1 ? 'Reported just now. ' : `Reported ${age < 60 ? `${age}m` : `${Math.floor(age / 60)}h`} ago. `}Updates as workspaces reply; sessions started outside this app are not counted.`,
      'settings-note',
    ),
  );
}

export function usageCard(s: SystemSnapshot, usageRange: UsageRangeId, onRange: (id: UsageRangeId) => void): HTMLElement {
  const range = USAGE_RANGES.find((r) => r.id === usageRange) ?? USAGE_RANGES[2];
  const summary = summarizeUsage(s.usage.daily, range.days);
  // Today is drawn by hour. An older helper sends no hours, and then one bar is no chart, so it is drawn against its week.
  const hourly = range.days === 1 && s.usage.hourly?.length === 24 ? s.usage.hourly : null;
  const nowHour = new Date(s.takenAt).getHours();
  const days = s.usage.daily.slice(-(range.days === 1 ? 7 : range.days));
  const bars = hourly
    ? hourly.map((h) => ({
        label: `${String(h.hour).padStart(2, '0')}:00`,
        tokens: h.tokens,
        costUsd: h.costUsd,
        state: h.hour === nowHour ? 'now' : h.hour > nowHour ? 'context' : '',
      }))
    : days.map((d, i) => ({
        label: d.day,
        tokens: d.tokens,
        costUsd: d.costUsd,
        state: i === days.length - 1 ? 'now' : i < days.length - range.days ? 'context' : '',
      }));
  const peak = Math.max(1, ...bars.map((b) => b.tokens));
  const chart = el('div', '', `usage-chart${bars.length > 14 ? ' dense' : ''}`);
  for (const { label, tokens, costUsd, state } of bars) {
    const bar = el('div', '', `usage-bar${state ? ` ${state}` : ''}`);
    const fill = el('span', '', 'usage-fill');
    // An hour or day with any use shows a sliver, so it is not mistaken for a quiet one.
    fill.style.height = `${tokens > 0 ? Math.max(4, (tokens / peak) * 100) : 0}%`;
    bar.title = `${label}\n${dayFigures(tokens, costUsd)}`;
    bar.append(fill);
    chart.append(bar);
  }
  const axis = el('div', '', 'usage-axis');
  axis.append(
    el('span', hourly ? '00:00' : shortDay(days[0].day)),
    el('span', `peak ${formatTokens(peak > 1 ? peak : 0)}`),
    el('span', hourly ? '23:00' : 'today'),
  );

  const change = usageChange(summary, summary.previous);
  const headline = el('div', '', 'usage-headline');
  headline.append(el('span', `~${formatUsd(summary.costUsd)}`, 'usage-cost'), el('span', `${formatTokens(summary.tokens)} tokens`, 'usage-tokens'));
  if (change) headline.append(el('span', `${change} vs ${previousLabel(range.days)}`, 'usage-change'));

  const rows: HTMLElement[] = [];
  if (summary.tokens === 0 && summary.costUsd === 0) {
    rows.push(el('p', `No usage ${range.days === 1 ? 'today' : `in the last ${range.days} days`}.`, 'settings-note'));
  } else {
    if (range.days > 1) {
      rows.push(
        row('Per day', dayFigures(Math.round(summary.tokens / range.days), summary.costUsd / range.days), `Averaged over all ${range.days} days`),
        row('Active days', `${summary.activeDays} of ${range.days}`),
      );
      if (summary.busiest) rows.push(row('Busiest day', `${shortDay(summary.busiest.day)} · ${dayFigures(summary.busiest.tokens, summary.busiest.costUsd)}`));
    }
    const outputShare = summary.tokens > 0 ? ` (${Math.round((summary.output / summary.tokens) * 100)}% of new work)` : '';
    rows.push(
      row('Output', `${formatTokens(summary.output)} tokens${outputShare}`),
      row(
        'Cache reads',
        `${formatTokens(summary.cacheRead)} tokens`,
        'Input served from the prompt cache. It repeats earlier input, so it is not counted in the totals above.',
      ),
    );
    if (summary.models.length) {
      const total = summary.costUsd > 0 ? summary.costUsd : summary.tokens;
      const lines = summary.models.slice(0, MODEL_ROWS).map((m) => {
        const share = total > 0 ? Math.round(((summary.costUsd > 0 ? m.costUsd : m.tokens) / total) * 100) : 0;
        return `${m.model} · ${dayFigures(m.tokens, m.costUsd)} · ${share}%`;
      });
      const more = summary.models.length - MODEL_ROWS;
      rows.push(row('By model', [...lines, ...(more > 0 ? [`+ ${more} more`] : [])].join('\n')));
    }
  }

  const rates = Object.entries(s.config.pricing)
    .map(([family, r]) => `${family} $${r.input}/$${r.output}`)
    .join(', ');
  return card(
    'Usage',
    rangePicker(usageRange, onRange),
    headline,
    chart,
    axis,
    ...rows,
    row(
      'Since sessions began',
      `~${formatUsd(s.usage.costUsd)} estimated${s.usage.counting ? ' (still counting…)' : ''}`,
      'Across every workspace transcript still on disk',
    ),
    ...(s.usage.unpriced.length
      ? [
          el(
            'p',
            `No rate for ${s.usage.unpriced.join(', ')}, so ${s.usage.unpriced.length === 1 ? 'it is' : 'they are'} missing from the cost. Add ${s.usage.unpriced.length === 1 ? 'it' : 'them'} under "pricing" in the config.`,
            'settings-note warn',
          ),
        ]
      : []),
    el(
      'p',
      `Dollar figures are estimates. Days are in your local time. Rates (per million tokens, input/output): ${rates}. Cache writes cost 1.25× input and cache reads 0.1×. Set "pricing" in the config to correct them.`,
      'settings-note',
    ),
  );
}
