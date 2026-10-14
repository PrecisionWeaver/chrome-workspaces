// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlToHelper, SystemSnapshot, UpdateStatus, UsageDay, UsageHour } from '../../shared/protocol';
import type { TimelineEvent } from '../../shared/timeline';
import { createSettingsView, formatBytes, formatDuration, formatKb, formatTokens, newTokens, type SettingsView } from '../src/settings-view';
import { installChrome } from './chrome-mock';
import { isolateDocumentListeners, loadPanelHtml, makeSession, makeSnapshot, makeUsageDay, makeUsageHours } from './fixtures';

isolateDocumentListeners();

describe('formatBytes and formatKb', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [1536, '1.5 KB'],
    [1024 * 1024, '1.0 MB'],
    [5.5 * 1024 * 1024, '5.5 MB'],
    [1024 ** 3, '1.00 GB'],
    [2.5 * 1024 ** 3, '2.50 GB'],
  ])('%d bytes reads %s', (bytes, expected) => expect(formatBytes(bytes)).toBe(expected));

  it('reads kilobytes as bytes', () => expect(formatKb(2048)).toBe('2.0 MB'));
});

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1.0K'],
    [1234, '1.2K'],
    [99_999, '100.0K'],
    [150_000, '150K'],
    [1_200_000, '1.2M'],
    [250_000_000, '250M'],
    [3_400_000_000, '3.4B'],
  ])('%d reads %s', (count, expected) => expect(formatTokens(count)).toBe(expected));
});

describe('newTokens', () => {
  it('leaves out cache reads, which repeat earlier input', () => {
    expect(newTokens({ input: 1, output: 2, cacheWrite: 3, cacheRead: 1000 })).toBe(6);
  });
});

describe('formatDuration', () => {
  it.each([
    [5, '5s'],
    [65, '1m 5s'],
    [3700, '1h 1m'],
    [90_000, '1d 1h'],
  ])('%d seconds reads %s', (seconds, expected) => expect(formatDuration(seconds)).toBe(expected));
});

const NOW = Date.parse('2026-03-10T12:00:00.000Z');

let fake: ReturnType<typeof installChrome>;
let view: SettingsView;
let sent: ControlToHelper[];
let toggled: number;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cards = () => [...document.querySelectorAll<HTMLElement>('#settings-body .settings-card')];
const card = (key: string) => cards().find((node) => node.dataset.key === key)!;
const text = (selector: string, root: ParentNode = document) => [...root.querySelectorAll(selector)].map((node) => node.textContent);
const button = (label: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!;
const sentOfType = <T extends ControlToHelper['type']>(type: T) =>
  sent.filter((message): message is Extract<ControlToHelper, { type: T }> => message.type === type);
const requests = () => sentOfType('admin').map((message) => message.request);
const flush = () => vi.advanceTimersByTimeAsync(0);
const kv = (root: ParentNode) =>
  Object.fromEntries([...root.querySelectorAll('.kv')].map((row) => [row.querySelector('.k')!.textContent, row.querySelector('.v')!.textContent]));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = installChrome();
  fake.mock.commands.getAll.mockResolvedValue([{ name: 'next-workspace', shortcut: 'Ctrl+Shift+Right' }]);
  loadPanelHtml();
  sent = [];
  toggled = 0;
  view = createSettingsView({ send: (message) => (sent.push(message), true), onToggle: () => void toggled++ });
  await flush();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Opens the view with a snapshot already in, and clears the opening requests. */
async function open(snapshot: SystemSnapshot = makeSnapshot()) {
  view.setSystem({ type: 'system', snapshot, error: null });
  view.show();
  await flush();
  sent.length = 0;
}

describe('opening, closing and polling', () => {
  it('shows a loading note, asks the helper straight away, and tells the panel', () => {
    view.show();
    expect($('settings').hidden).toBe(false);
    expect($('settings-body').textContent).toBe('Loading…');
    expect(sent).toEqual([{ type: 'system' }]);
    expect(view.isOpen).toBe(true);
    expect(toggled).toBe(1);
  });

  it('asks again every three seconds while open, and stops when closed', () => {
    view.show();
    sent.length = 0;
    vi.advanceTimersByTime(6000);
    expect(sentOfType('system')).toHaveLength(2);
    view.close();
    expect($('settings').hidden).toBe(true);
    vi.advanceTimersByTime(6000);
    expect(sentOfType('system')).toHaveLength(2);
    expect(toggled).toBe(2);
  });

  it('closes from its button, and not twice', () => {
    view.show();
    $('settings-close').click();
    expect(view.isOpen).toBe(false);
    view.close();
    expect(toggled).toBe(2);
  });

  it('closes on Escape, but only while open', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(toggled).toBe(0);
    view.show();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(view.isOpen).toBe(false);
  });

  it('refreshes on the refresh button, also polling the open activity lists and the log', async () => {
    await open();
    $('settings-refresh').click();
    expect(sent).toEqual([{ type: 'system' }]);
  });

  it('shows what time the snapshot is from', async () => {
    await open();
    expect($('settings-updated').textContent).toMatch(/^updated /);
  });

  it('says why the system could not be read, until a snapshot arrives', () => {
    view.show();
    view.setSystem({ type: 'system', snapshot: null, error: 'helper is busy' });
    expect($('settings-body').textContent).toBe('Could not read the system: helper is busy');
    expect($('settings-updated').textContent).toBe('');
  });

  it('keeps the last snapshot when a later answer has none', async () => {
    await open();
    view.setSystem({ type: 'system', snapshot: null, error: 'timeout' });
    expect(cards().length).toBeGreaterThan(0);
  });

  it('does not draw while closed, and draws what arrived when opened', () => {
    view.setSystem({ type: 'system', snapshot: makeSnapshot(), error: null });
    expect(cards()).toHaveLength(0);
    view.show();
    expect(cards().length).toBeGreaterThan(0);
  });
});

describe('result banner', () => {
  it('shows an admin result for eight seconds, and polls so the change shows', async () => {
    await open();
    view.setResult({ type: 'adminResult', action: 'clearLog', ok: true, message: 'Log cleared.' });
    expect($('settings-result').hidden).toBe(false);
    expect($('settings-result').className).toBe('ok');
    expect($('settings-result').textContent).toBe('Log cleared.');
    expect(sentOfType('system')).toHaveLength(1);
    vi.advanceTimersByTime(8000);
    expect($('settings-result').hidden).toBe(true);

    view.setResult({ type: 'adminResult', action: 'x', ok: false, message: 'nope' });
    expect($('settings-result').className).toBe('bad');
  });

  it('is cleared when the view opens again', async () => {
    await open();
    view.setResult({ type: 'adminResult', action: 'x', ok: true, message: 'done' });
    view.close();
    view.show();
    expect($('settings-result').hidden).toBe(true);
  });
});

describe('the cards', () => {
  it('lists them in order, with the setup and warning cards first only when there is something to show', async () => {
    await open();
    expect(cards().map((node) => node.dataset.key)).toEqual([
      'Preferences',
      'Helper',
      'Updates',
      'Usage',
      'Workspace sessions',
      'Housekeeping',
      'Configuration',
      'Diagnostics',
    ]);
  });

  describe('Helper', () => {
    it('shows the helper’s facts', async () => {
      await open();
      expect(kv(card('Helper'))).toEqual({
        Status: 'Running',
        Process: 'pid 42',
        Uptime: '1h 1m',
        Memory: '50.0 MB',
        Port: '4000',
        Node: 'v22.18.0',
        Version: 'abc1234',
        'Panels connected': '2',
      });
    });

    it('says unknown when the version is not known', async () => {
      const snapshot = makeSnapshot();
      await open({ ...snapshot, helper: { ...snapshot.helper, commit: null } });
      expect(kv(card('Helper')).Version).toBe('unknown');
    });

    it('asks twice before restarting or stopping, and sends the request on the second click', async () => {
      await open();
      const helper = card('Helper');
      button('Restart helper', helper).click();
      expect(requests()).toEqual([]);
      expect(button('Ends every terminal. Restart?', card('Helper'))).toBeDefined();
      button('Ends every terminal. Restart?', card('Helper')).click();
      expect(requests()).toEqual([{ action: 'restartHelper' }]);

      button('Stop helper', card('Helper')).click();
      button('Stop until started again?', card('Helper')).click();
      expect(requests()).toEqual([{ action: 'restartHelper' }, { action: 'stopHelper' }]);
    });

    it('disarms a confirmation after four seconds', async () => {
      await open();
      button('Stop helper', card('Helper')).click();
      vi.advanceTimersByTime(4000);
      expect(button('Stop helper', card('Helper'))).toBeDefined();
      button('Stop helper', card('Helper')).click();
      expect(requests()).toEqual([]);
    });

    it('cannot restart or stop a helper that was started by hand, and says why', async () => {
      const snapshot = makeSnapshot();
      await open({ ...snapshot, helper: { ...snapshot.helper, managed: false } });
      for (const label of ['Restart helper', 'Stop helper']) {
        const b = button(label, card('Helper'));
        expect(b.disabled).toBe(true);
        expect(b.title).toContain('npm run agent:start');
      }
    });

    it('shows and hides the log, asking for it, and keeping it current while shown', async () => {
      await open();
      button('Show log', card('Helper')).click();
      expect(sentOfType('systemLog')).toHaveLength(1);
      expect(card('Helper').querySelector('.settings-log')!.textContent).toBe('Loading…');
      view.setLog('line one\nline two');
      expect(card('Helper').querySelector('.settings-log')!.textContent).toBe('line one\nline two');
      view.setLog('');
      expect(card('Helper').querySelector('.settings-log')!.textContent).toBe('(empty)');

      sent.length = 0;
      vi.advanceTimersByTime(3000);
      expect(sentOfType('systemLog')).toHaveLength(1);

      button('Hide log', card('Helper')).click();
      expect(card('Helper').querySelector('.settings-log')).toBeNull();
      sent.length = 0;
      vi.advanceTimersByTime(3000);
      expect(sentOfType('systemLog')).toEqual([]);
    });

    it('ignores a log that arrives after it was hidden', async () => {
      await open();
      view.setLog('stray');
      expect(card('Helper').querySelector('.settings-log')).toBeNull();
    });
  });

  describe('Preferences', () => {
    it('shows the saved theme, density and notification choice', async () => {
      // happy-dom picks the wrong option when `selected` is set before appending, so the choices tested sit second in their lists.
      fake.storage.local.prefs = { theme: 'dark', density: 'compact', notify: true };
      loadPanelHtml();
      view = createSettingsView({ send: () => true, onToggle: () => {} });
      await flush();
      await open();
      const selects = [...card('Preferences').querySelectorAll<HTMLSelectElement>('select')];
      expect(selects.map((select) => select.value)).toEqual(['dark', 'compact']);
      expect(card('Preferences').querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(true);
    });

    it('offers each theme and density, capitalised', async () => {
      await open();
      const selects = [...card('Preferences').querySelectorAll<HTMLSelectElement>('select')];
      expect(selects.map((select) => [...select.options].map((option) => option.textContent))).toEqual([
        ['System', 'Dark', 'Light'],
        ['Comfortable', 'Compact'],
      ]);
    });

    it('saves a change at once', async () => {
      await open();
      const [theme, density] = [...card('Preferences').querySelectorAll<HTMLSelectElement>('select')] as [HTMLSelectElement, HTMLSelectElement];
      // Each is saved on top of what the last stored, so they are made one after another as a person would.
      theme.value = 'dark';
      theme.dispatchEvent(new Event('change'));
      await flush();
      density.value = 'compact';
      density.dispatchEvent(new Event('change'));
      await flush();
      const box = card('Preferences').querySelector<HTMLInputElement>('input[type=checkbox]')!;
      box.checked = true;
      box.dispatchEvent(new Event('change'));
      await flush();
      expect(fake.storage.local.prefs).toEqual({ theme: 'dark', density: 'compact', notify: true, setupDismissed: false, usageRange: '14d' });
    });
  });

  describe('Updates', () => {
    const status = (overrides: Partial<UpdateStatus> = {}): UpdateStatus => ({
      current: 'abc1234',
      branch: 'main',
      upstream: 'origin/main',
      release: 'v1.3.0',
      behind: 0,
      ahead: 0,
      dirty: false,
      commits: [],
      canUpdate: true,
      reason: null,
      ...overrides,
    });

    it('explains itself and offers to check before anything has been checked', async () => {
      await open();
      expect(text('.settings-note', card('Updates'))[0]).toContain('newest release');
      button('Check for updates', card('Updates')).click();
      expect(sentOfType('checkUpdates')).toHaveLength(1);
      expect(button('Checking…', card('Updates')).disabled).toBe(true);
    });

    it('says it is up to date, with what is running and the latest release', async () => {
      await open();
      view.setUpdates({ type: 'updates', status: status(), error: null });
      expect(kv(card('Updates'))).toEqual({ Running: 'abc1234 on main (tracks origin/main)', 'Latest release': 'v1.3.0' });
      expect(text('.settings-note', card('Updates'))).toEqual(['Already up to date.']);
      expect(button('Update now', card('Updates'))).toBeUndefined();
    });

    it('says why it is not behind when the helper gives a reason', async () => {
      await open();
      view.setUpdates({ type: 'updates', status: status({ reason: 'On a feature branch.', upstream: null, release: null }), error: null });
      expect(text('.settings-note', card('Updates'))).toEqual(['On a feature branch.']);
      expect(kv(card('Updates'))).toEqual({ Running: 'abc1234 on main' });
    });

    it('lists the commits an update brings, and how many more there are', async () => {
      await open();
      view.setUpdates({
        type: 'updates',
        status: status({
          behind: 5,
          commits: [
            { short: 'a1', subject: 'Fix it' },
            { short: 'b2', subject: 'Add it' },
          ],
        }),
        error: null,
      });
      expect(kv(card('Updates')).Available).toBe('5 new commits');
      expect(text('.update-commit', card('Updates'))).toEqual(['a1  Fix it', 'b2  Add it', '…and 3 more']);
    });

    it('uses the singular for one commit', async () => {
      await open();
      view.setUpdates({ type: 'updates', status: status({ behind: 1, commits: [{ short: 'a1', subject: 'Fix it' }] }), error: null });
      expect(kv(card('Updates')).Available).toBe('1 new commit');
      expect(text('.update-commit.more', card('Updates'))).toEqual([]);
    });

    it('asks twice before updating, then waits for the helper and offers to reload the extension', async () => {
      await open();
      view.setUpdates({ type: 'updates', status: status({ behind: 1, commits: [{ short: 'a1', subject: 'Fix it' }] }), error: null });
      button('Update now', card('Updates')).click();
      expect(requests()).toEqual([]);
      button('Update, rebuild and restart?', card('Updates')).click();
      expect(requests()).toEqual([{ action: 'applyUpdate' }]);
      expect(text('.settings-note', card('Updates'))[0]).toContain('The helper is restarting');
      button('Reload extension', card('Updates')).click();
      expect(fake.mock.runtime.reload).toHaveBeenCalled();
    });

    it('cannot update when it is not safe, and says why', async () => {
      await open();
      view.setUpdates({ type: 'updates', status: status({ behind: 2, canUpdate: false, reason: 'Uncommitted changes.', commits: [] }), error: null });
      expect(button('Update now', card('Updates')).disabled).toBe(true);
      expect(button('Update now', card('Updates')).title).toBe('Uncommitted changes.');
      expect(text('.settings-note.warn', card('Updates'))).toEqual(['Uncommitted changes.']);
    });

    it('says when a check failed, and lets it be tried again', async () => {
      await open();
      view.setUpdates({ type: 'updates', status: null, error: 'offline' });
      expect(text('.settings-note.warn', card('Updates'))).toEqual(['Could not check: offline']);
      button('Check for updates', card('Updates')).click();
      expect(sentOfType('checkUpdates')).toHaveLength(1);
    });
  });

  describe('Usage', () => {
    const usage = (overrides: Partial<SystemSnapshot['usage']> = {}): SystemSnapshot['usage'] => ({
      daily: [
        makeUsageDay({ day: '2026-03-09', tokens: 1_000_000, costUsd: 3 }),
        makeUsageDay({ day: '2026-03-10', tokens: 10 }),
        makeUsageDay({ day: '2026-03-11' }),
      ],
      hourly: makeUsageHours(),
      costUsd: 12.5,
      counting: false,
      unpriced: [],
      ...overrides,
    });
    const bars = () => [...card('Usage').querySelectorAll<HTMLElement>('.usage-bar')];
    const headline = () => text('.usage-headline span', card('Usage'));
    const pick = async (label: string) => {
      button(label, card('Usage')).click();
      await flush();
    };

    /** Sixty days ending 2026-03-11: ten tokens and a dollar each, but a hundred and ten dollars today. */
    const sixty = (): UsageDay[] =>
      Array.from({ length: 60 }, (_, i) => {
        const day = new Date(Date.UTC(2026, 2, 11) - (59 - i) * 86_400_000).toISOString().slice(0, 10);
        const today = i === 59;
        return makeUsageDay({
          day,
          tokens: today ? 100 : 10,
          costUsd: today ? 10 : 1,
          output: today ? 40 : 4,
          cacheRead: 1000,
          models: [{ model: 'claude-opus-5-5', tokens: today ? 100 : 10, costUsd: today ? 10 : 1 }],
        });
      });

    it('draws a bar a day, scaled to the busiest, with a sliver for any use and nothing for none', async () => {
      await open(makeSnapshot({ usage: usage() }));
      expect(bars().map((bar) => bar.querySelector<HTMLElement>('.usage-fill')!.style.height)).toEqual(['100%', '4%', '0%']);
      expect(bars()[0]!.title).toBe('2026-03-09\n1.0M tokens · ~$3.00');
    });

    it('offers today, 7, 14 and 30 days, with 14 chosen to begin with', async () => {
      await open(makeSnapshot({ usage: usage() }));
      const buttons = [...card('Usage').querySelectorAll<HTMLButtonElement>('.usage-range-btn')];
      expect(buttons.map((b) => b.textContent)).toEqual(['Today', '7 days', '14 days', '30 days']);
      expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'true', 'false']);
    });

    it('draws as many bars as the range has days', async () => {
      await open(makeSnapshot({ usage: usage({ daily: sixty() }) }));
      expect(bars()).toHaveLength(14);
      await pick('30 days');
      expect(bars()).toHaveLength(30);
      expect(card('Usage').querySelector('.usage-chart')!.classList.contains('dense')).toBe(true);
      await pick('7 days');
      expect(bars()).toHaveLength(7);
      expect(bars().map((bar) => bar.classList.contains('now'))).toEqual([false, false, false, false, false, false, true]);
    });

    it('draws today by hour, marking the hour it is and dimming those still to come', async () => {
      const hourly = makeUsageHours({ 9: { tokens: 400, costUsd: 4 }, 11: { tokens: 100 }, 14: { tokens: 50 } });
      await open(makeSnapshot({ usage: usage({ daily: sixty(), hourly }) }));
      await pick('Today');
      expect(bars()).toHaveLength(24);
      expect(bars()[9]!.title).toBe('09:00 UTC\n400 tokens · ~$4.00');
      expect(bars()[9]!.querySelector<HTMLElement>('.usage-fill')!.style.height).toBe('100%');
      expect(bars()[11]!.querySelector<HTMLElement>('.usage-fill')!.style.height).toBe('25%');
      expect(bars()[3]!.querySelector<HTMLElement>('.usage-fill')!.style.height).toBe('0%');
      // The snapshot was taken at 12:00 UTC.
      expect(
        bars().map((bar, hour) => (bar.classList.contains('now') ? 'now' : bar.classList.contains('context') ? 'later' : 'past' + (hour > 12 ? '!' : ''))),
      ).toEqual([...Array(12).fill('past'), 'now', ...Array(11).fill('later')]);
      expect(text('.usage-axis span', card('Usage'))).toEqual(['00:00', 'peak 400', '23:00 UTC']);
    });

    it('draws today against its week when the helper sends no hours', async () => {
      await open(makeSnapshot({ usage: { ...usage({ daily: sixty() }), hourly: undefined as unknown as UsageHour[] } }));
      await pick('Today');
      expect(bars()).toHaveLength(7);
      expect(bars().map((bar) => bar.classList.contains('context'))).toEqual([true, true, true, true, true, true, false]);
    });

    it('changes the cost and tokens, and how they compare with the range before, as the range does', async () => {
      await open(makeSnapshot({ usage: usage({ daily: sixty() }) }));
      await pick('Today');
      expect(headline()).toEqual(['~$10', '100 tokens', '↑ 900% vs yesterday']);
      await pick('7 days');
      expect(headline()).toEqual(['~$16', '160 tokens', '↑ 129% vs the previous 7 days']);
      await pick('14 days');
      expect(headline()).toEqual(['~$23', '230 tokens', '↑ 64% vs the previous 14 days']);
      await pick('30 days');
      expect(headline()).toEqual(['~$39', '390 tokens', '↑ 30% vs the previous 30 days']);
    });

    it('remembers the range, and uses it when the view is made again', async () => {
      await open(makeSnapshot({ usage: usage({ daily: sixty() }) }));
      await pick('30 days');
      expect(fake.storage.local.prefs).toMatchObject({ usageRange: '30d' });
      loadPanelHtml();
      view = createSettingsView({ send: () => true, onToggle: () => {} });
      await flush();
      await open(makeSnapshot({ usage: usage({ daily: sixty() }) }));
      expect(bars()).toHaveLength(30);
      expect(button('30 days', card('Usage')).getAttribute('aria-pressed')).toBe('true');
    });

    it('breaks the range down: per day, active days, busiest day, output, cache reads and model', async () => {
      await open(makeSnapshot({ usage: usage({ daily: sixty() }) }));
      await pick('7 days');
      expect(kv(card('Usage'))).toEqual({
        'Per day': '23 tokens · ~$2.29',
        'Active days': '7 of 7',
        'Busiest day': 'Mar 11 · 100 tokens · ~$10',
        Output: '64 tokens (40% of new work)',
        'Cache reads': '7.0K tokens',
        'By model': 'claude-opus-5-5 · 160 tokens · ~$16 · 100%',
        'Since sessions began': '~$13 estimated',
      });
    });

    it('leaves out the per-day figures for a single day, which has no spread', async () => {
      await open(makeSnapshot({ usage: usage({ daily: sixty() }) }));
      await pick('Today');
      expect(Object.keys(kv(card('Usage')))).toEqual(['Output', 'Cache reads', 'By model', 'Since sessions began']);
    });

    it('lists the dearest models first, and folds the rest into a count', async () => {
      const models = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((model, i) => ({ model, tokens: 10, costUsd: i + 1 }));
      await open(makeSnapshot({ usage: usage({ daily: [makeUsageDay({ day: '2026-03-11', tokens: 70, costUsd: 28, models })] }) }));
      const lines = kv(card('Usage'))['By model']!.split('\n');
      expect(lines.map((line) => line.split(' · ')[0])).toEqual(['g', 'f', 'e', 'd', 'c', '+ 2 more']);
      expect(lines[0]).toBe('g · 10 tokens · ~$7.00 · 25%');
    });

    it('says so when a range has no usage, rather than showing a page of zeros', async () => {
      await open(makeSnapshot({ usage: usage({ daily: [makeUsageDay({ day: '2026-03-11' })] }) }));
      expect(text('.settings-note', card('Usage'))[0]).toBe('No usage in the last 14 days.');
      expect(headline()).toEqual(['~$0', '0 tokens']);
      await pick('Today');
      expect(text('.settings-note', card('Usage'))[0]).toBe('No usage today.');
    });

    it('notes that counting is not done, and totals the cost since the sessions began', async () => {
      await open(makeSnapshot({ usage: usage({ counting: true }) }));
      expect(kv(card('Usage'))['Since sessions began']).toBe('~$13 estimated (still counting…)');
    });

    it('names the models that have no rate, singular or plural', async () => {
      await open(makeSnapshot({ usage: usage({ unpriced: ['mystery'] }) }));
      expect(text('.settings-note.warn', card('Usage'))[0]).toBe('No rate for mystery, so it is missing from the cost. Add it under "pricing" in the config.');
      await open(makeSnapshot({ usage: usage({ unpriced: ['a', 'b'] }) }));
      expect(text('.settings-note.warn', card('Usage'))[0]).toBe(
        'No rate for a, b, so they are missing from the cost. Add them under "pricing" in the config.',
      );
    });

    it('shows the rates', async () => {
      await open();
      expect(text('.settings-note', card('Usage')).at(-1)).toContain('opus $15/$75');
    });
  });

  describe('Workspace sessions', () => {
    const running = makeSession({ id: 'ws-a', name: 'acme/app', pid: 10 });
    const stopped = makeSession({ id: 'ws-b', name: 'acme/api', pid: null, processes: [] });

    it('lists running sessions first, with the count in the title', async () => {
      await open(makeSnapshot({ sessions: [stopped, running] }));
      expect(card('Workspace sessions').querySelector('h3')!.textContent).toBe('Workspace sessions · 1 running');
      expect(text('.session-name', card('Workspace sessions'))).toEqual(['acme/app', 'acme/api']);
      expect(text('.session-detail', card('Workspace sessions'))).toEqual(['1 process · 2.0 MB', 'not running']);
    });

    it('says when there are no workspaces', async () => {
      await open(makeSnapshot({ sessions: [] }));
      expect(text('.settings-empty', card('Workspace sessions'))).toEqual(['No workspaces yet.']);
    });

    it('shows tokens and cost, once counted, with the total in the title', async () => {
      const tokens = { input: 1000, output: 500, cacheWrite: 500, cacheRead: 90_000, costUsd: 0.42, counting: false };
      await open(makeSnapshot({ sessions: [{ ...running, tokens }] }));
      expect(card('Workspace sessions').querySelector('h3')!.textContent).toBe('Workspace sessions · 1 running · 2.0K tokens');
      expect(text('.session-tokens', card('Workspace sessions'))).toEqual(['2.0K tokens · ~$0.42']);
      expect(card('Workspace sessions').querySelector<HTMLElement>('.session-tokens')!.title).toContain('cache read 90,000');
    });

    it('says counting while the first read runs, and leaves it out of the total', async () => {
      const tokens = { input: 1000, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0, counting: true };
      await open(makeSnapshot({ sessions: [{ ...running, tokens }] }));
      expect(text('.session-tokens', card('Workspace sessions'))).toEqual(['counting tokens…']);
      expect(card('Workspace sessions').querySelector('h3')!.textContent).toBe('Workspace sessions · 1 running');
    });

    it('shows what claude is doing, and a missing directory', async () => {
      await open(makeSnapshot({ sessions: [{ ...running, status: 'needs_input', cwdMissing: true }] }));
      expect(text('.chip', card('Workspace sessions'))).toEqual(['needs input', 'directory missing']);
    });

    it('shows no status for a session that is not running', async () => {
      await open(makeSnapshot({ sessions: [{ ...stopped, status: 'working' }] }));
      expect(text('.chip', card('Workspace sessions'))).toEqual([]);
    });

    it('expands a running session to its processes, with ports, and collapses it again', async () => {
      const processes = [
        { pid: 10, ppid: 1, command: '-zsh', cpu: 0, rssKb: 1024, elapsed: '10:00', ports: [] },
        { pid: 11, ppid: 10, command: 'node server.js', cpu: 12.34, rssKb: 51_200, elapsed: '09:00', ports: [3000, 3001] },
      ];
      await open(makeSnapshot({ sessions: [{ ...running, processes }] }));
      const toggle = () => card('Workspace sessions').querySelector<HTMLButtonElement>('.session-toggle')!;
      expect(toggle().textContent).toBe('▸');
      toggle().click();
      expect(toggle().textContent).toBe('▾');
      expect(text('.proc .cmd', card('Workspace sessions'))).toEqual(['-zsh', 'node server.js']);
      expect(text('.proc .num', card('Workspace sessions'))).toEqual(['0.0%', '1.0 MB', '10:00', '12.3%', '50.0 MB', '09:00']);
      expect(text('.port', card('Workspace sessions'))).toEqual([':3000', ':3001']);
      expect(card('Workspace sessions').querySelector('.session-detail')!.textContent).toBe('2 processes · 51.0 MB · :3000 :3001');
      toggle().click();
      expect(card('Workspace sessions').querySelector('.procs')).toBeNull();
    });

    it('cannot expand or restart a session that is not running', async () => {
      await open(makeSnapshot({ sessions: [stopped] }));
      expect(card('Workspace sessions').querySelector<HTMLButtonElement>('.session-toggle')!.disabled).toBe(true);
      expect(button('Restart', card('Workspace sessions')).disabled).toBe(true);
      expect(button('Restart', card('Workspace sessions')).title).toContain('starts when the workspace is opened');
    });

    it('restarts a session after asking twice', async () => {
      await open(makeSnapshot({ sessions: [running] }));
      button('Restart', card('Workspace sessions')).click();
      button('End its shell?', card('Workspace sessions')).click();
      expect(requests()).toEqual([{ action: 'restartSession', id: 'ws-a' }]);
    });

    describe('processes', () => {
      const processes = [
        { pid: 10, ppid: 1, command: '-zsh', cpu: 0, rssKb: 1024, elapsed: '10:00', ports: [] },
        { pid: 11, ppid: 10, command: 'node server.js', cpu: 1, rssKb: 1024, elapsed: '09:00', ports: [3000] },
      ];
      const expand = async () => {
        await open(makeSnapshot({ sessions: [{ ...running, processes }] }));
        card('Workspace sessions').querySelector<HTMLButtonElement>('.session-toggle')!.click();
      };

      it('stops or force kills a process after asking twice, but never the shell itself', async () => {
        await expand();
        const rows = card('Workspace sessions').querySelectorAll('.proc');
        expect(rows[0]!.querySelector('.proc-actions')).toBeNull();
        button('Stop', rows[1] as HTMLElement).click();
        button('Stop it and its children?', card('Workspace sessions')).click();
        button('Force', card('Workspace sessions').querySelectorAll('.proc')[1] as HTMLElement).click();
        button('Force kill (SIGKILL)?', card('Workspace sessions')).click();
        expect(requests()).toEqual([
          { action: 'killProcess', id: 'ws-a', pid: 11 },
          { action: 'killProcess', id: 'ws-a', pid: 11, force: true },
        ]);
      });

      it('opens a listening port in a tab', async () => {
        await expand();
        card('Workspace sessions').querySelector<HTMLButtonElement>('.port')!.click();
        expect(fake.mock.tabs.create).toHaveBeenCalledWith({ url: 'http://localhost:3000' });
      });
    });

    describe('activity', () => {
      const events: TimelineEvent[] = [
        { at: '2026-03-10T11:00:00.000Z', kind: 'you', tool: '', summary: 'Fix the bug' },
        { at: '2026-03-10T11:01:00.000Z', kind: 'tool', tool: 'Edit', summary: 'Edit a.ts', file: '/src/a.ts' },
        { at: '2026-03-10T11:02:00.000Z', kind: 'tool', tool: 'Read', summary: 'Read b.ts', file: '/src/b.ts' },
        { at: '2026-03-10T11:03:00.000Z', kind: 'tool', tool: 'Write', summary: 'Write a.ts again', file: '/src/a.ts' },
        { at: '', kind: 'said', tool: '', summary: 'Done' },
      ];
      const expand = async () => {
        await open(makeSnapshot({ sessions: [running] }));
        card('Workspace sessions').querySelector<HTMLButtonElement>('.session-toggle')!.click();
        button('Show activity', card('Workspace sessions')).click();
      };

      it('asks for the timeline, shows loading, and keeps it current while shown', async () => {
        await expand();
        expect(sentOfType('timeline')).toEqual([{ type: 'timeline', id: 'ws-a' }]);
        expect(card('Workspace sessions').querySelector('.activity')!.textContent).toBe('Loading…');
        sent.length = 0;
        vi.advanceTimersByTime(3000);
        expect(sentOfType('timeline')).toEqual([{ type: 'timeline', id: 'ws-a' }]);
        button('Hide activity', card('Workspace sessions')).click();
        sent.length = 0;
        vi.advanceTimersByTime(3000);
        expect(sentOfType('timeline')).toEqual([]);
      });

      it('lists events newest first, naming who or what did each, and the files changed but not merely read', async () => {
        await expand();
        view.setTimeline({ type: 'timeline', id: 'ws-a', events, error: null });
        const activity = card('Workspace sessions').querySelector('.activity')!;
        expect(text('.activity-kind', activity)).toEqual(['Claude', 'Write', 'Read', 'Edit', 'You']);
        expect(text('.activity-text', activity)).toEqual(['Done', 'Write a.ts again', 'Read b.ts', 'Edit a.ts', 'Fix the bug']);
        expect(activity.querySelector('.activity-files')!.textContent).toBe('Changed 1 file: a.ts');
        expect(activity.querySelector<HTMLElement>('.activity-files')!.title).toBe('/src/a.ts');
        expect(text('.activity-time', activity)[0]).toBe('');
      });

      it('names several changed files, in the order first changed', async () => {
        await expand();
        view.setTimeline({
          type: 'timeline',
          id: 'ws-a',
          error: null,
          events: [
            { at: '', kind: 'tool', tool: 'Edit', summary: 'x', file: '/src/b.ts' },
            { at: '', kind: 'tool', tool: 'Edit', summary: 'y', file: '/lib/c.ts' },
          ],
        });
        expect(card('Workspace sessions').querySelector('.activity-files')!.textContent).toBe('Changed 2 files: b.ts, c.ts');
      });

      it('says when there is nothing yet, or it could not be read', async () => {
        await expand();
        view.setTimeline({ type: 'timeline', id: 'ws-a', events: [], error: null });
        expect(card('Workspace sessions').querySelector('.activity')!.textContent).toBe('Nothing yet.');
        view.setTimeline({ type: 'timeline', id: 'ws-a', events: [], error: 'no transcript' });
        expect(card('Workspace sessions').querySelector('.activity')!.textContent).toBe('no transcript');
      });
    });
  });

  describe('Housekeeping', () => {
    it('shows the sizes and the review fetch', async () => {
      await open(makeSnapshot({ storage: { uploadsBytes: 5 * 1024 * 1024, logBytes: 2048, dataBytes: 1024 } }));
      const facts = kv(card('Housekeeping'));
      expect(facts.Uploads).toBe('5.0 MB');
      expect(facts['Helper log']).toBe('2.0 KB');
      expect(facts['Data folder']).toBe('1.0 KB');
      expect(facts['Review requests']).toMatch(/^3 PRs, fetched /);
    });

    it('says reviews are not fetched yet, or what last went wrong', async () => {
      await open(makeSnapshot({ reviews: { fetchedAt: null, count: 0, error: null } }));
      expect(kv(card('Housekeeping'))['Review requests']).toBe('not fetched yet');
      await open(makeSnapshot({ reviews: { fetchedAt: '2026-03-10T11:00:00.000Z', count: 2, error: 'gh: not logged in\nmore' } }));
      expect(kv(card('Housekeeping'))['Review requests']).toContain('(last error: gh: not logged in)');
    });

    it('asks twice before clearing uploads or the log', async () => {
      await open();
      button('Clear uploads', card('Housekeeping')).click();
      button('Delete all uploads?', card('Housekeeping')).click();
      button('Clear log', card('Housekeeping')).click();
      button('Empty the log?', card('Housekeeping')).click();
      expect(requests()).toEqual([{ action: 'clearUploads' }, { action: 'clearLog' }]);
    });

    it('prunes worktrees, refreshes reviews and exports at one click', async () => {
      await open();
      button('Prune worktrees', card('Housekeeping')).click();
      button('Refresh reviews', card('Housekeeping')).click();
      button('Export workspaces', card('Housekeeping')).click();
      expect(requests()).toEqual([{ action: 'pruneWorktrees' }]);
      expect(sent.map((message) => message.type)).toEqual(['admin', 'refreshReviews', 'exportData']);
    });
  });

  describe('Configuration', () => {
    it('shows the effective config', async () => {
      const snapshot = makeSnapshot();
      await open({
        ...snapshot,
        config: { ...snapshot.config, repoDirs: { app: '/Users/me/app' }, watchRepos: ['acme/app'], defaultModel: 'opus' },
      });
      const facts = kv(card('Configuration'));
      expect(facts['Default directory']).toBe('/Users/me');
      expect(facts['Default model']).toBe('opus');
      expect(facts.Command).toBe('claude');
      expect(facts['Repo folders']).toBe('/Users/me/code');
      expect(facts['Repo directories']).toBe('app → /Users/me/app');
      expect(facts['Watched repos']).toBe('acme/app');
      expect(facts.Prices).toBe('opus: $15 in / $75 out');
      expect(facts['Warn above']).toBe('4096 MB per workspace · servers idle 4 h');
      expect(text('.settings-note', card('Configuration'))[0]).toBe(
        'Read from /Users/me/.chrome-workspaces/config.json. Edit it and restart the helper to change these.',
      );
    });

    it('says none for empty lists, and claude’s own model by default', async () => {
      const snapshot = makeSnapshot();
      await open({ ...snapshot, config: { ...snapshot.config, repoRoots: [] } });
      const facts = kv(card('Configuration'));
      expect(facts['Repo folders']).toBe('none');
      expect(facts['Repo directories']).toBe('none');
      expect(facts['Watched repos']).toBe('none');
      expect(facts['Default model']).toBe("claude's own");
    });
  });

  describe('Diagnostics', () => {
    it('says whether the helper’s extension id matches this extension', async () => {
      await open();
      expect(kv(card('Diagnostics'))['Extension ID']).toBe('Matches this extension');
      const snapshot = makeSnapshot();
      await open({ ...snapshot, helper: { ...snapshot.helper, extensionId: 'other-id' } });
      expect(kv(card('Diagnostics'))['Extension ID']).toBe('Does not match this extension (ext-id)');
    });

    it('runs the GitHub check', async () => {
      await open();
      button('Check GitHub CLI', card('Diagnostics')).click();
      expect(requests()).toEqual([{ action: 'checkGh' }]);
    });

    it('copies debug info, without the config or any prompts, and says so', async () => {
      const writeText = vi.fn(async () => {});
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      await open();
      button('Copy debug info', card('Diagnostics')).click();
      const copied = JSON.parse((writeText.mock.calls[0] as unknown as [string])[0]);
      expect(Object.keys(copied)).toEqual(['extension', 'helper', 'storage', 'sessions']);
      expect(copied.extension).toBe('1.2.3');
      expect(copied.sessions).toEqual([{ id: 'ws-00000001', pid: 100, status: null, cwdMissing: false }]);
      expect($('settings-result').textContent).toBe('Debug info copied.');
    });
  });

  describe('Needs attention', () => {
    const warnings = [
      { id: 'ws-a', name: 'acme/app', kind: 'memory' as const, message: 'acme/app is using 5 GB' },
      { id: 'ws-a', name: 'acme/app', kind: 'idle-server' as const, message: 'A server on :3000 has been idle 6 h', pid: 77 },
    ];

    it('lists warnings with their count, and the limits', async () => {
      await open(makeSnapshot({ warnings }));
      expect(cards()[0]!.dataset.key).toBe('Needs attention');
      expect(text('.warning-text', cards()[0]!)).toEqual(['acme/app is using 5 GB', 'A server on :3000 has been idle 6 h']);
      expect(cards()[0]!.querySelector('h3')!.textContent).toBe('Needs attention · 2');
      expect(text('.settings-note', cards()[0]!)[0]).toContain('4096 MB per workspace, servers idle over 4 h');
      expect(view.warningCount).toBe(2);
    });

    it('offers to stop only an idle server, after asking twice', async () => {
      await open(makeSnapshot({ warnings }));
      expect(cards()[0]!.querySelectorAll('button')).toHaveLength(1);
      button('Stop it', cards()[0]!).click();
      button('Stop it?', cards()[0]!).click();
      expect(requests()).toEqual([{ action: 'killProcess', id: 'ws-a', pid: 77 }]);
    });

    it('is absent when there are no warnings', async () => {
      await open();
      expect(card('Needs attention')).toBeUndefined();
      expect(view.warningCount).toBe(0);
    });
  });

  describe('Getting started', () => {
    const incomplete = () => makeSnapshot({ setup: { promptsFileExists: false, repoRoots: [], statusHooks: true, configProblems: [] } });

    it('lists what is done and what is not, with what to do about it', async () => {
      await open(incomplete());
      const setup = card('Getting started');
      expect(setup.querySelector('h3')!.textContent).toBe('Getting started · 7 of 9 done');
      const open_ = [...setup.querySelectorAll('.setup-row:not(.done)')];
      expect(open_.map((row) => row.querySelector('.setup-label')!.textContent)).toEqual(['Prompts file', 'Repo folders']);
      expect(open_[0]!.querySelector('.setup-detail')!.textContent).toContain('npm run setup');
      expect(setup.querySelectorAll('.setup-row.done .setup-detail')).toHaveLength(0);
      expect(view.setupRemaining).toBe(2);
    });

    it('is absent when everything is done', async () => {
      await open();
      expect(card('Getting started')).toBeUndefined();
      expect(view.setupRemaining).toBe(0);
    });

    it('counts the switch shortcut as open until one is bound', async () => {
      fake.mock.commands.getAll.mockResolvedValue([]);
      view.setSystem({ type: 'system', snapshot: makeSnapshot(), error: null });
      await flush();
      view.show();
      expect(card('Getting started').querySelector('.setup-row:not(.done) .setup-label')!.textContent).toBe('Switch shortcut');
    });

    it('can be dismissed, remembering that, and then stops counting', async () => {
      await open(incomplete());
      button('Dismiss', card('Getting started')).click();
      await flush();
      expect(card('Getting started')).toBeUndefined();
      expect(fake.storage.local.prefs).toMatchObject({ setupDismissed: true });
      expect(view.setupRemaining).toBe(0);
    });

    it('stays dismissed when the view is made again', async () => {
      fake.storage.local.prefs = { setupDismissed: true };
      loadPanelHtml();
      view = createSettingsView({ send: () => true, onToggle: () => {} });
      await flush();
      await open(incomplete());
      expect(card('Getting started')).toBeUndefined();
    });
  });
});

describe('redrawing', () => {
  it('keeps the scroll position', async () => {
    await open();
    $('settings-body').scrollTop = 120;
    view.setSystem({ type: 'system', snapshot: makeSnapshot(), error: null });
    expect($('settings-body').scrollTop).toBe(120);
  });

  it('leaves a card with a focused dropdown in place, so the dropdown stays open', async () => {
    await open();
    const select = card('Preferences').querySelector<HTMLSelectElement>('select')!;
    select.focus();
    const before = card('Preferences');
    view.setSystem({ type: 'system', snapshot: makeSnapshot({ helper: { ...makeSnapshot().helper, pid: 99 } }), error: null });
    expect(card('Preferences')).toBe(before);
    expect(kv(card('Helper')).Process).toBe('pid 99');
  });
});

describe('download', () => {
  it('saves the export as a dated JSON file, then releases it', () => {
    const create = vi.fn(() => 'blob:abc');
    const revoke = vi.fn();
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
    const clicked: { download: string; href: string }[] = [];
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      clicked.push({ download: this.download, href: this.href });
    };
    view.download('{"a":1}');
    HTMLAnchorElement.prototype.click = click;
    expect(clicked).toEqual([{ download: 'chrome-workspaces-2026-03-10.json', href: 'blob:abc' }]);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith('blob:abc');
  });
});
