// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAction, ControlToHelper, SystemProcess } from '../../../shared/protocol/protocol';
import { installChrome } from '../../testing/chrome-mock';
import { makeSession, makeSnapshot } from '../../testing/fixtures';
import { createArming } from '../ui/dom';
import type { SettingsContext } from './settings-parts';
import { newSessionsState, type SessionsState, workspacesCard } from './settings-sessions';

const ARM_MS = 4000;

function fakeContext() {
  const sent: ControlToHelper[] = [];
  const requests: AdminAction[] = [];
  const results: { ok: boolean; message: string }[] = [];
  let renders = 0;
  const ctx: SettingsContext = {
    send: (message) => (sent.push(message), true),
    request: (action) => void requests.push(action),
    render: () => void renders++,
    showResult: (result) => void results.push(result),
    arming: createArming(() => void renders++, ARM_MS),
  };
  return { ctx, sent, requests, results, renders: () => renders };
}

const text = (selector: string, root: ParentNode) => [...root.querySelectorAll(selector)].map((n) => n.textContent);
const button = (label: string, root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!;
const proc = (overrides: Partial<SystemProcess> = {}): SystemProcess => ({
  pid: 10,
  ppid: 1,
  command: '-zsh',
  cpu: 0.5,
  rssKb: 1024,
  elapsed: '10:00',
  ports: [],
  ...overrides,
});
const tokens = { input: 1000, output: 500, cacheWrite: 100, cacheRead: 20_000, costUsd: 0, counting: false };

let fake: ReturnType<typeof installChrome>;
let state: SessionsState;

beforeEach(() => {
  vi.useFakeTimers();
  fake = installChrome();
  state = newSessionsState();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('workspacesCard', () => {
  it('starts with nothing expanded or shown', () => {
    expect(newSessionsState()).toEqual({ expanded: new Set(), procScroll: new Map(), activityOpen: new Set(), activity: new Map() });
  });

  it('counts the running sessions in the title, and the tokens once counted', () => {
    const { ctx } = fakeContext();
    const sessions = [
      makeSession({ id: 'ws-a', tokens: { ...tokens, counting: false } }),
      makeSession({ id: 'ws-b', tokens: { ...tokens, counting: true } }),
      makeSession({ id: 'ws-c', pid: null, processes: [], tokens: { ...tokens, input: 400 } }),
    ];
    const node = workspacesCard(ctx, state, makeSnapshot({ sessions }));
    expect(node.dataset.key).toBe('Workspaces');
    // The counting one is left out; the stopped one still counts, since its tokens are known.
    expect(node.querySelector('h3')!.textContent).toBe('Workspaces · 2 running · 2.6K tokens');
    expect(workspacesCard(ctx, state, makeSnapshot({ sessions: [makeSession()] })).querySelector('h3')!.textContent).toBe('Workspaces · 1 running');
  });

  it('puts running sessions first, keeping each group in its order', () => {
    const { ctx } = fakeContext();
    const sessions = [
      makeSession({ id: 'ws-a', name: 'acme/old', pid: null, processes: [] }),
      makeSession({ id: 'ws-b', name: 'acme/app' }),
      makeSession({ id: 'ws-c', name: 'acme/older', pid: null, processes: [] }),
      makeSession({ id: 'ws-d', name: 'acme/api' }),
    ];
    expect(text('.session-name', workspacesCard(ctx, state, makeSnapshot({ sessions })))).toEqual(['acme/app', 'acme/api', 'acme/old', 'acme/older']);
  });

  it('says when there are no workspaces, and still totals the helper', () => {
    const { ctx } = fakeContext();
    const node = workspacesCard(ctx, state, makeSnapshot({ sessions: [] }));
    expect(node.querySelector('.settings-empty')!.textContent).toBe('No workspaces yet.');
    expect(text('.memory-line .k', node)).toEqual(['Helper', 'Total']);
    expect(text('.memory-line .v', node)).toEqual(['50.0 MB · 1.5%', '50.0 MB · 1.5%']);
  });

  it('adds every process to the helper for the total, in its own line', () => {
    const { ctx } = fakeContext();
    const sessions = [makeSession({ processes: [proc({ rssKb: 10_240, cpu: 2 }), proc({ pid: 11, rssKb: 10_240, cpu: 3 })] })];
    const node = workspacesCard(ctx, state, makeSnapshot({ sessions }));
    expect(node.querySelector('.memory-total .v')!.textContent).toBe('70.0 MB · 6.5%');
    expect(node.querySelector('.memory-total')!.getAttribute('title')).toBeTruthy();
  });

  describe('a session row', () => {
    it('sums its processes into the usage column, with the ports, and names the directory in its title', () => {
      const { ctx } = fakeContext();
      const session = makeSession({
        cwd: '/Users/me/acme',
        processes: [proc({ rssKb: 2048, cpu: 1 }), proc({ pid: 11, rssKb: 2048, cpu: 1.5, ports: [3000, 5173] })],
      });
      const node = workspacesCard(ctx, state, makeSnapshot({ sessions: [session] }));
      expect(node.querySelector('.session-usage')!.textContent).toBe('4.0 MB · 2.5% · :3000 :5173');
      expect(node.querySelector<HTMLElement>('.session-summary')!.title).toBe('/Users/me/acme');
    });

    it('says not running for a stopped session, whose toggle is disabled with no caret', () => {
      const { ctx } = fakeContext();
      const node = workspacesCard(ctx, state, makeSnapshot({ sessions: [makeSession({ pid: null, processes: [], status: 'working' })] }));
      expect(node.querySelector('.session-usage')!.textContent).toBe('not running');
      expect(node.querySelector<HTMLButtonElement>('.session-toggle')!.disabled).toBe(true);
      expect(node.querySelector('.session-toggle .caret')).toBeNull();
      expect(node.querySelector('.session-chip')).toBeNull();
    });

    it('chips what claude is doing while running, and a missing directory', () => {
      const { ctx } = fakeContext();
      const node = workspacesCard(ctx, state, makeSnapshot({ sessions: [makeSession({ status: 'needs_input', cwdMissing: true })] }));
      expect(text('.session-chip', node)).toEqual(['needs input', 'directory missing']);
      expect(node.querySelector('.session-chip')!.className).toBe('session-chip needs_input');
    });

    it('shows the new tokens with the cost, explaining cache reads and the estimate in the title', () => {
      const { ctx } = fakeContext();
      const priced = workspacesCard(ctx, state, makeSnapshot({ sessions: [makeSession({ tokens: { ...tokens, costUsd: 1.25 } })] }));
      expect(priced.querySelector('.session-tokens')!.textContent).toBe('1.6K tokens · ~$1.25');
      const title = priced.querySelector<HTMLElement>('.session-tokens')!.title;
      expect(title).toContain('input 1,000 · output 500 · cache written 100 · cache read 20,000');
      expect(title).toContain('Cache reads are repeats of earlier input');
      expect(title).toContain('The dollar figure is an estimate');

      const free = workspacesCard(ctx, state, makeSnapshot({ sessions: [makeSession({ tokens })] }));
      expect(free.querySelector('.session-tokens')!.textContent).toBe('1.6K tokens');
      expect(free.querySelector<HTMLElement>('.session-tokens')!.title).not.toContain('estimate');
    });

    it('says counting while the first read runs', () => {
      const { ctx } = fakeContext();
      const node = workspacesCard(ctx, state, makeSnapshot({ sessions: [makeSession({ tokens: { ...tokens, counting: true } })] }));
      expect(node.querySelector('.session-tokens')!.textContent).toBe('counting tokens…');
    });

    it('expands and collapses through the state, redrawing each time', () => {
      const { ctx, renders } = fakeContext();
      const snapshot = makeSnapshot({ sessions: [makeSession({ id: 'ws-a' })] });
      const closed = workspacesCard(ctx, state, snapshot);
      expect(closed.querySelector('.procs')).toBeNull();
      expect(closed.querySelector('.session-toggle .caret.open')).toBeNull();
      closed.querySelector<HTMLButtonElement>('.session-toggle')!.click();
      expect([...state.expanded]).toEqual(['ws-a']);
      expect(renders()).toBe(1);

      const open = workspacesCard(ctx, state, snapshot);
      expect(open.querySelector('.session-toggle .caret.open')).not.toBeNull();
      expect(open.querySelector<HTMLElement>('.procs')!.dataset.session).toBe('ws-a');
      open.querySelector<HTMLButtonElement>('.session-toggle')!.click();
      expect(state.expanded.size).toBe(0);
      expect(renders()).toBe(2);
    });

    it('stays collapsed when an expanded session stops', () => {
      const { ctx } = fakeContext();
      state.expanded.add('ws-a');
      const node = workspacesCard(ctx, state, makeSnapshot({ sessions: [makeSession({ id: 'ws-a', pid: null, processes: [] })] }));
      expect(node.querySelector('.procs')).toBeNull();
    });
  });

  describe('a session expanded', () => {
    const processes = [proc(), proc({ pid: 11, ppid: 10, command: 'node server.js', cpu: 1, rssKb: 4096, elapsed: '09:00', ports: [3000] })];
    const expand = (ctx: SettingsContext, id = 'ws-a') => {
      state.expanded.add(id);
      return workspacesCard(ctx, state, makeSnapshot({ sessions: [makeSession({ id, processes })] }));
    };

    it('lists each process with its figures, marking the shell, which cannot be stopped', () => {
      const { ctx } = fakeContext();
      const rows = [...expand(ctx).querySelectorAll<HTMLElement>('.proc')];
      expect(rows.map((r) => r.className)).toEqual(['proc shell', 'proc']);
      expect(rows.map((r) => r.querySelector('.cmd')!.textContent)).toEqual(['-zsh', 'node server.js']);
      expect(rows[1]!.title).toBe('node server.js');
      expect(text('.num', rows[1]!)).toEqual(['1.0%', '4.0 MB', '09:00']);
      expect(rows[0]!.querySelector('.proc-actions')).toBeNull();
      expect(rows[1]!.querySelector('.proc-actions')).not.toBeNull();
    });

    it('stops or force kills a process after asking twice', () => {
      const { ctx, requests } = fakeContext();
      const row = expand(ctx).querySelectorAll<HTMLElement>('.proc')[1]!;
      button('Stop', row).click();
      expect(requests).toEqual([]);
      button('Stop', row).click();
      const force = button('Force', row);
      expect(force.classList.contains('danger')).toBe(true);
      force.click();
      force.click();
      expect(requests).toEqual([
        { action: 'killProcess', id: 'ws-a', pid: 11 },
        { action: 'killProcess', id: 'ws-a', pid: 11, force: true },
      ]);
    });

    it('opens a listening port in a tab', () => {
      const { ctx } = fakeContext();
      const chip = expand(ctx).querySelector<HTMLButtonElement>('.port')!;
      expect(chip.textContent).toBe(':3000');
      expect(chip.title).toBe('Open localhost:3000');
      chip.click();
      expect(fake.mock.tabs.create).toHaveBeenCalledWith({ url: 'http://localhost:3000' });
    });

    it('remembers where the process list was scrolled to', () => {
      const { ctx } = fakeContext();
      const list = expand(ctx).querySelector<HTMLElement>('.procs')!;
      expect(list.classList.contains('fixed')).toBe(true);
      list.scrollTop = 40;
      list.dispatchEvent(new Event('scroll'));
      expect(state.procScroll.get('ws-a')).toBe(40);
    });

    it('counts the processes and restarts the shell after asking twice', () => {
      const { ctx, requests } = fakeContext();
      const node = expand(ctx);
      expect(node.querySelector('.session-count')!.textContent).toBe('2 processes');
      button('Restart', node).click();
      button('Restart', node).click();
      expect(requests).toEqual([{ action: 'restartSession', id: 'ws-a' }]);
      state.expanded.clear();
      state.expanded.add('ws-b');
      const one = workspacesCard(ctx, state, makeSnapshot({ sessions: [makeSession({ id: 'ws-b', processes: [proc()] })] }));
      expect(one.querySelector('.session-count')!.textContent).toBe('1 process');
    });

    it('asks for the activity when it is shown, and only then, through the state', () => {
      const { ctx, sent, renders } = fakeContext();
      const node = expand(ctx);
      const link = button('Show activity', node);
      expect(link.getAttribute('aria-expanded')).toBe('false');
      expect(node.querySelector('.activity')).toBeNull();
      link.click();
      expect([...state.activityOpen]).toEqual(['ws-a']);
      expect(sent).toEqual([{ type: 'timeline', id: 'ws-a' }]);
      expect(renders()).toBe(1);

      const shown = expand(ctx);
      expect(button('Hide activity', shown).getAttribute('aria-expanded')).toBe('true');
      expect(shown.querySelector('.activity')!.textContent).toBe('Loading…');
      button('Hide activity', shown).click();
      expect(state.activityOpen.size).toBe(0);
      expect(sent).toHaveLength(1);
    });

    it('names the claude session and copies its id', () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const { ctx, results } = fakeContext();
      state.expanded.add('ws-a');
      const session = makeSession({ id: 'ws-a', claudeSessionId: '0b7c1b4a-1234-4abc-8def-0123456789ab' });
      const copy = button('Session 0b7c1b4a', workspacesCard(ctx, state, makeSnapshot({ sessions: [session] })));
      expect(copy.title).toBe('Copy 0b7c1b4a-1234-4abc-8def-0123456789ab');
      copy.click();
      expect(writeText).toHaveBeenCalledWith('0b7c1b4a-1234-4abc-8def-0123456789ab');
      expect(results).toEqual([{ ok: true, message: 'Session id copied.' }]);
      expect(button('Session 0b7c1b4a', expand(ctx))).toBeUndefined();
    });

    it('shows what came back for the activity: an error, nothing, or the events', () => {
      const { ctx } = fakeContext();
      state.activityOpen.add('ws-a');
      state.activity.set('ws-a', { events: [], error: 'no transcript' });
      expect(expand(ctx).querySelector('.activity')!.textContent).toBe('no transcript');
      state.activity.set('ws-a', { events: [], error: null });
      expect(expand(ctx).querySelector('.activity')!.textContent).toBe('Nothing yet.');
      state.activity.set('ws-a', { events: [{ at: '2026-03-10T11:00:00.000Z', kind: 'you', tool: '', summary: 'Fix the bug' }], error: null });
      const row = expand(ctx).querySelector<HTMLElement>('.activity-row')!;
      expect(row.className).toBe('activity-row you');
      expect(row.title).toBe('Fix the bug');
      expect(text('.activity-kind', row)).toEqual(['You']);
    });
  });

  describe('the trend chart', () => {
    const sample = (i: number, rssKb: number, cpu: number) => ({ t: 1_000_000 + i * 60_000, rssKb, cpu });

    it('needs a few samples, and is amber once memory is over the limit', () => {
      const { ctx } = fakeContext();
      const few = makeSession({ id: 'ws-a', history: [sample(0, 1000, 1), sample(1, 1000, 1)] });
      expect(workspacesCard(ctx, state, makeSnapshot({ sessions: [few] })).querySelector('.session-trend')).toBeNull();

      const over = makeSession({ id: 'ws-b', history: [sample(0, 1000, 1), sample(1, 1000, 1), sample(2, 5_000 * 1024, 1)] });
      const node = workspacesCard(ctx, state, makeSnapshot({ sessions: [over] }));
      expect(node.querySelector('.session-trend .resource-chart')!.classList.contains('warn')).toBe(true);
    });

    it('reads a long span in hours in its title', () => {
      const { ctx } = fakeContext();
      const history = Array.from({ length: 90 }, (_, i) => sample(i, 1000 + i, 1));
      const trend = workspacesCard(ctx, state, makeSnapshot({ sessions: [makeSession({ history })] })).querySelector<HTMLElement>('.session-trend')!;
      expect(trend.title.split('\n')[0]).toBe('Over the last 1h 29m');
    });

    it('is not drawn for a stopped session', () => {
      const { ctx } = fakeContext();
      const stopped = makeSession({ pid: null, processes: [], history: [sample(0, 1000, 1), sample(1, 1000, 1), sample(2, 1000, 1)] });
      expect(workspacesCard(ctx, state, makeSnapshot({ sessions: [stopped] })).querySelector('.session-trend')).toBeNull();
    });
  });
});
