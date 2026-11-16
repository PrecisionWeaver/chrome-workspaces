// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAction } from '../../../shared/protocol/protocol';
import { warningKey } from '../../../shared/usage/guardrails';
import { installChrome } from '../../testing/chrome-mock';
import { makeSnapshot } from '../../testing/fixtures';
import { normalizePrefs, type Prefs } from '../app/prefs';
import { createArming } from '../ui/dom';
import { setupCard, setupChecklist, shownWarnings, warningsCard } from './settings-attention';
import type { PrefsHandle, SettingsContext } from './settings-parts';

let prefs: Prefs;
let changes: Partial<Prefs>[];
let renders: number;
let requests: AdminAction[];
let ctx: SettingsContext;
const handle: PrefsHandle = {
  get: () => prefs,
  set(change) {
    changes.push(change);
    prefs = { ...prefs, ...change };
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  installChrome();
  prefs = normalizePrefs(undefined);
  changes = [];
  renders = 0;
  requests = [];
  ctx = {
    send: () => true,
    request: (action) => void requests.push(action),
    render: () => void renders++,
    showResult: () => {},
    arming: createArming(() => {}, 4000),
  };
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const button = (root: HTMLElement, label: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === label)!;

const memory = { id: 'ws-a', name: 'acme/app', kind: 'memory' as const, message: 'acme/app is using 5 GB' };
const server = { id: 'ws-a', name: 'acme/app', kind: 'idle-server' as const, message: 'A server on :3000 has been idle 6 h', pid: 77 };

describe('setupCard', () => {
  it('lists every step, marking the done ones, with how far along it is', () => {
    // No prompts file is a step that cannot be done, so the card is there whatever else is set up.
    const snapshot = makeSnapshot({ setup: { ...makeSnapshot().setup, promptsFileExists: false } });
    const items = setupChecklist(snapshot, '');
    const done = items.filter((item) => item.ok).length;
    expect(done).toBeLessThan(items.length);
    const card = setupCard(ctx, handle, '', snapshot)!;
    expect(card.dataset.key).toBe('Getting started');
    expect(card.querySelector('h3')!.textContent).toBe(`Getting started · ${done} of ${items.length} done`);
    expect(card.querySelectorAll('.setup-row')).toHaveLength(items.length);
    expect(card.querySelectorAll('.setup-row.done')).toHaveLength(done);
  });

  it('counts a bound switch shortcut as done', () => {
    const snapshot = makeSnapshot();
    const shortcut = (bound: string) => setupChecklist(snapshot, bound).find((item) => /shortcut/i.test(item.label));
    expect(shortcut('')?.ok).toBe(false);
    expect(shortcut('⌘⇧Y')?.ok).toBe(true);
  });

  it('can be dismissed for good, and then is not shown', () => {
    const snapshot = makeSnapshot({ setup: { ...makeSnapshot().setup, promptsFileExists: false } });
    const card = setupCard(ctx, handle, '', snapshot);
    expect(card).not.toBeNull();
    button(card!, 'Dismiss').click();
    expect(changes).toEqual([{ setupDismissed: true }]);
    expect(renders).toBe(1);
    expect(setupCard(ctx, handle, '', snapshot)).toBeNull();
  });
});

describe('warningsCard', () => {
  it('shows nothing without warnings, else each with a count and the limits', () => {
    expect(warningsCard(ctx, handle, makeSnapshot({ warnings: [] }))).toBeNull();
    const card = warningsCard(ctx, handle, makeSnapshot({ warnings: [memory, server] }))!;
    expect(card.querySelector('h3')!.textContent).toBe('Needs attention · 2');
    expect([...card.querySelectorAll('.warning-text')].map((n) => n.textContent)).toEqual([memory.message, server.message]);
    expect(card.querySelector('.settings-note')!.textContent).toContain('servers idle over');
  });

  it('offers to stop only an idle server, after asking twice', () => {
    const snapshot = makeSnapshot({ warnings: [memory, server] });
    const rows = () => [...warningsCard(ctx, handle, snapshot)!.querySelectorAll<HTMLElement>('.warning-row')];
    expect(rows()[0]!.textContent).not.toContain('Stop it');
    button(rows()[1]!, 'Stop it').click();
    expect(requests).toEqual([]);
    button(rows()[1]!, 'Stop it?').click();
    expect(requests).toEqual([{ action: 'killProcess', id: 'ws-a', pid: 77 }]);
  });

  it('keeps a dismissed warning hidden, and lists it again if it is no longer dismissed', () => {
    const snapshot = makeSnapshot({ warnings: [memory, server] });
    button(warningsCard(ctx, handle, snapshot)!.querySelectorAll<HTMLElement>('.warning-row')[0]!, 'Dismiss').click();
    expect(changes).toEqual([{ dismissedWarnings: [warningKey(memory)] }]);
    expect(renders).toBe(1);
    expect(shownWarnings(handle, snapshot)).toEqual([server]);
    expect(warningsCard(ctx, handle, snapshot)!.querySelector('h3')!.textContent).toBe('Needs attention · 1');
    prefs = { ...prefs, dismissedWarnings: [] };
    expect(shownWarnings(handle, snapshot)).toEqual([memory, server]);
  });
});
