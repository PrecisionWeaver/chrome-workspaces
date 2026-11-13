// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { SystemSnapshot, UsageDay } from '../../../shared/protocol/protocol';
import { makeSnapshot, makeUsageDay, makeUsageHours } from '../../testing/fixtures';
import { planCard, usageCard } from './settings-usage';

// The hour a snapshot was taken in is the person's own, so the zone is pinned: 12:00 UTC is 08:00 in Eastern Daylight Time.
process.env.TZ = 'America/New_York';
const NOW = '2026-03-10T12:00:00.000Z';
const resets = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

const kv = (root: ParentNode) =>
  Object.fromEntries([...root.querySelectorAll('.kv')].map((line) => [line.querySelector('.k')!.textContent, line.querySelector('.v')!.textContent]));
const text = (selector: string, root: ParentNode) => [...root.querySelectorAll(selector)].map((n) => n.textContent);
const notes = (root: ParentNode) => text('.settings-note', root);

/** Ten days ending today, each with ten tokens and a dollar; tests set the days they care about. */
const tenDays = (overrides: Record<string, Partial<UsageDay>> = {}): UsageDay[] =>
  Array.from({ length: 10 }, (_, i) => {
    const day = new Date(Date.UTC(2026, 2, 10) - (9 - i) * 86_400_000).toISOString().slice(0, 10);
    return makeUsageDay({
      day,
      tokens: 10,
      costUsd: 1,
      output: 4,
      cacheRead: 100,
      models: [{ model: 'claude-opus-5-5', tokens: 10, costUsd: 1 }],
      ...overrides[day],
    });
  });

const usage = (overrides: Partial<SystemSnapshot['usage']> = {}): SystemSnapshot['usage'] => ({
  daily: tenDays(),
  hourly: makeUsageHours(),
  workspaces: [],
  costUsd: 12.5,
  counting: false,
  unpriced: [],
  ...overrides,
});

describe('planCard', () => {
  it('keys the card and says what is needed when there are no figures', () => {
    const node = planCard(makeSnapshot());
    expect(node.dataset.key).toBe('Plan usage');
    expect(node.querySelector('.plan-limit')).toBeNull();
    expect(notes(node)[0]).toContain('No figures yet');
  });

  it('draws each limit as a progress bar the assistive tree can read', () => {
    const limits = [{ id: 'five_hour', label: 'Current session', percent: 23.5, resetsAt: resets(130) }];
    const bar = planCard(makeSnapshot({ plan: { limits, updatedAt: '2026-03-10T11:55:00.000Z' } })).querySelector('.plan-meter')!;
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-label')).toBe('Current session');
    expect(bar.getAttribute('aria-valuenow')).toBe('24');
    expect(bar.querySelector<HTMLElement>('.plan-meter-fill')!.style.width).toBe('23.5%');
    expect(bar.querySelector('.plan-meter-pace')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('warns in amber from 70% and in red from 90%', () => {
    const limits = [
      { id: 'five_hour', label: 'Current session', percent: 69.4, resetsAt: resets(60) },
      { id: 'seven_day', label: 'Current week', percent: 70, resetsAt: resets(60) },
      { id: 'spend_limit', label: 'Spend limit', percent: 90, resetsAt: resets(60) },
    ];
    const meters = planCard(makeSnapshot({ plan: { limits, updatedAt: null } })).querySelectorAll('.plan-meter');
    expect([...meters].map((m) => m.className)).toEqual(['plan-meter', 'plan-meter warn', 'plan-meter bad']);
  });

  it('says how old the figures are: just now, in minutes, then in hours, or nothing when never reported', () => {
    const limits = [{ id: 'five_hour', label: 'Current session', percent: 10, resetsAt: resets(60) }];
    const age = (updatedAt: string | null) => notes(planCard(makeSnapshot({ plan: { limits, updatedAt } })))[0]!;
    expect(age('2026-03-10T11:59:40.000Z')).toMatch(/^Reported just now\. /);
    expect(age('2026-03-10T11:15:00.000Z')).toMatch(/^Reported 45m ago\. /);
    expect(age('2026-03-10T09:30:00.000Z')).toMatch(/^Reported 2h ago\. /);
    expect(age(null)).toMatch(/^Updates as workspaces reply/);
  });
});

describe('usageCard', () => {
  const card = (s: Partial<SystemSnapshot['usage']> = {}, range: Parameters<typeof usageCard>[1] = '14d', onRange = vi.fn()) =>
    usageCard(makeSnapshot({ takenAt: NOW, usage: usage(s) }), range, onRange);

  describe('the range picker', () => {
    it('presses the chosen range and names the group for assistive tech', () => {
      const picker = card({}, 'week').querySelector('[role="group"]')!;
      expect(picker.getAttribute('aria-label')).toBe('Usage range');
      const buttons = [...picker.querySelectorAll<HTMLButtonElement>('button')];
      expect(buttons.map((b) => b.textContent)).toEqual(['Today', '7 days', '14 days', '30 days']);
      expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false', 'false']);
      expect(buttons.map((b) => b.classList.contains('active'))).toEqual([false, true, false, false]);
    });

    it('reports a change by id, and nothing for the range already chosen', () => {
      const onRange = vi.fn();
      const buttons = [...card({}, 'week', onRange).querySelectorAll<HTMLButtonElement>('.usage-range-btn')];
      buttons[1]!.click();
      expect(onRange).not.toHaveBeenCalled();
      buttons[3]!.click();
      expect(onRange).toHaveBeenCalledWith('30d');
    });

    it('draws 14 days for a range it does not know, with no button pressed', () => {
      const node = usageCard(makeSnapshot({ takenAt: NOW, usage: usage() }), 'bogus' as never, vi.fn());
      expect([...node.querySelectorAll<HTMLButtonElement>('.usage-range-btn')].map((b) => b.getAttribute('aria-pressed'))).toEqual([
        'false',
        'false',
        'false',
        'false',
      ]);
      expect(node.querySelectorAll('.usage-bar')).toHaveLength(10);
      expect(kv(node)['Active days']).toBe('10 of 14');
    });
  });

  describe('the figures', () => {
    it('averages per day over the whole range, counts the active days, and names the busiest', () => {
      const node = card({ daily: tenDays({ '2026-03-05': { tokens: 100, costUsd: 5 } }) }, 'week');
      const rows = kv(node);
      // Six days of ten and one of a hundred: 160 tokens and $11 over seven days.
      expect(rows['Per day']).toBe('23 tokens · ~$1.57');
      expect(rows['Active days']).toBe('7 of 7');
      expect(rows['Busiest day']).toBe('Mar 5 · 100 tokens · ~$5.00');
      expect([...node.querySelectorAll('.kv')].find((l) => l.querySelector('.k')!.textContent === 'Per day')!.getAttribute('title')).toBe(
        'Averaged over all 7 days',
      );
    });

    it('gives the output as a share of the new work, and the cache reads apart', () => {
      const rows = kv(card({}, 'week'));
      expect(rows.Output).toBe('28 tokens (40% of new work)');
      expect(rows['Cache reads']).toBe('700 tokens');
    });

    it('shows a dense chart for more than two weeks', () => {
      expect(card({ daily: tenDays() }, '14d').querySelector('.usage-chart')!.classList.contains('dense')).toBe(false);
      const thirty = Array.from({ length: 30 }, (_, i) =>
        makeUsageDay({ day: new Date(Date.UTC(2026, 2, 10) - (29 - i) * 86_400_000).toISOString().slice(0, 10), tokens: 1 }),
      );
      expect(card({ daily: thirty }, '30d').querySelector('.usage-chart')!.classList.contains('dense')).toBe(true);
    });

    it('says there is no usage, today or in the range, instead of a page of zeros', () => {
      const quiet = tenDays(Object.fromEntries(tenDays().map((d) => [d.day, { tokens: 0, costUsd: 0, output: 0, cacheRead: 0, models: [] }])));
      expect(notes(card({ daily: quiet }, 'week'))[0]).toBe('No usage in the last 7 days.');
      expect(notes(card({ daily: quiet }, 'today'))[0]).toBe('No usage today.');
      expect(card({ daily: quiet }, 'week').querySelector('.usage-split')).toBeNull();
    });
  });

  describe('the split by workspace', () => {
    const own = (name: string, tokens: number, costUsd: number) => ({ id: name, name, daily: [{ day: '2026-03-10', tokens, costUsd }] });

    it('sizes each bar by cost, and lists each as a tip', () => {
      const node = card({ workspaces: [own('acme/app', 100, 3), own('acme/api', 100, 1)] }, 'today');
      const rows = [...node.querySelectorAll<HTMLElement>('.usage-split-row')];
      expect(node.querySelector('.usage-split')!.getAttribute('role')).toBe('list');
      expect(rows.map((r) => r.querySelector<HTMLElement>('.usage-split-fill')!.style.width)).toEqual(['75%', '25%']);
      expect(rows.map((r) => r.querySelector('.usage-split-figure')!.textContent)).toEqual(['~$3.00 · 75%', '~$1.00 · 25%']);
      expect(rows[0]!.dataset.tip).toBe('acme/app\n100 tokens · ~$3.00');
    });

    it('sizes by tokens when nothing is priced, keeping a sliver for a small share', () => {
      const node = card({ workspaces: [own('acme/app', 990, 0), own('acme/api', 10, 0)] }, 'today');
      const rows = [...node.querySelectorAll<HTMLElement>('.usage-split-row')];
      expect(rows.map((r) => r.querySelector('.usage-split-figure')!.textContent)).toEqual(['990 · 99%', '10 · 1%']);
      expect(rows.map((r) => r.querySelector<HTMLElement>('.usage-split-fill')!.style.width)).toEqual(['99%', '2%']);
    });

    it('is left out for a single workspace', () => {
      expect(card({ workspaces: [own('acme/app', 100, 3)] }, 'today').querySelector('.usage-split')).toBeNull();
    });
  });

  describe('the totals and the rates', () => {
    it('totals the cost since the sessions began, noting when counting is not done', () => {
      expect(kv(card())['Since sessions began']).toBe('~$13');
      expect(kv(card({ costUsd: 1.234, counting: true }))['Since sessions began']).toBe('~$1.23 (still counting…)');
      expect(card().querySelector('.kv-total .k')!.textContent).toBe('Since sessions began');
    });

    it('names the models with no rate, in the singular or the plural', () => {
      expect(text('.settings-note.warn', card({ unpriced: ['claude-x'] }))).toEqual([
        'No rate for claude-x, so it is missing from the cost. Add it under "pricing" in the config.',
      ]);
      expect(text('.settings-note.warn', card({ unpriced: ['claude-x', 'claude-y'] }))).toEqual([
        'No rate for claude-x, claude-y, so they are missing from the cost. Add them under "pricing" in the config.',
      ]);
      expect(text('.settings-note.warn', card())).toEqual([]);
    });

    it('shows the rates from the config', () => {
      expect(notes(card()).at(-1)).toBe('Estimated at opus $15/$75 per million tokens, input/output. Change them under "pricing" in the config.');
    });
  });
});
