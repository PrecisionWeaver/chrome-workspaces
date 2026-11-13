// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAction, ControlToHelper, UpdateStatus } from '../../../shared/protocol/protocol';
import { installChrome } from '../../testing/chrome-mock';
import { makeSession, makeSnapshot } from '../../testing/fixtures';
import { createArming } from '../ui/dom';
import { helperCard, type HelperState, newHelperState } from './settings-helper';
import type { SettingsContext } from './settings-parts';

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

const kv = (root: ParentNode) =>
  Object.fromEntries([...root.querySelectorAll('.kv')].map((line) => [line.querySelector('.k')!.textContent, line.querySelector('.v')!.textContent]));
const button = (label: string, root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === label)!;
const notes = (root: ParentNode) => [...root.querySelectorAll('.settings-note')].map((n) => n.textContent);

const status = (overrides: Partial<UpdateStatus> = {}): UpdateStatus => ({
  current: 'abc1234',
  branch: 'main',
  upstream: 'origin/main',
  release: 'v0.24.0',
  behind: 0,
  ahead: 0,
  dirty: false,
  commits: [],
  canUpdate: true,
  reason: null,
  ...overrides,
});

let fake: ReturnType<typeof installChrome>;
let state: HelperState;

beforeEach(() => {
  vi.useFakeTimers();
  fake = installChrome();
  state = newHelperState();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('helperCard', () => {
  it('starts with no log shown and nothing checked', () => {
    expect(newHelperState()).toEqual({ logText: null, updates: null });
  });

  it('lays out the facts in order, and keys the card as Helper', () => {
    const { ctx } = fakeContext();
    const node = helperCard(ctx, state, makeSnapshot());
    expect(node.dataset.key).toBe('Helper');
    expect(Object.keys(kv(node))).toEqual([
      'Status',
      'Process',
      'Uptime',
      'Memory',
      'CPU',
      'Port',
      'Node',
      'Version',
      'Connections',
      'Extension ID',
      'Review requests',
    ]);
    expect(kv(node).Process).toBe('pid 42');
    expect(kv(node).Version).toBe('abc1234');
    expect(node.querySelector('.settings-log')).toBeNull();
  });

  describe('checking for updates', () => {
    it('marks the check as running, asks the helper, and redraws', () => {
      const { ctx, sent, renders } = fakeContext();
      button('Check for updates', helperCard(ctx, state, makeSnapshot())).click();
      expect(state.updates).toEqual({ status: null, error: null, checking: true, applied: false });
      expect(sent).toEqual([{ type: 'checkUpdates' }]);
      expect(renders()).toBe(1);
    });

    it('keeps the last answer while a new check runs, and cannot be pressed again meanwhile', () => {
      const { ctx } = fakeContext();
      state.updates = { status: status({ behind: 1, commits: [{ short: 'def5678', subject: 'Fix it' }] }), error: null, checking: false, applied: false };
      button('Check for updates', helperCard(ctx, state, makeSnapshot())).click();
      expect(state.updates.status?.behind).toBe(1);
      expect(state.updates.checking).toBe(true);
      const checking = button('Checking…', helperCard(ctx, state, makeSnapshot()));
      expect(checking.disabled).toBe(true);
    });
  });

  describe('the version rows for each answer', () => {
    it('shows what tracks what, and the latest release, when up to date', () => {
      const { ctx } = fakeContext();
      state.updates = { status: status(), error: null, checking: false, applied: false };
      const node = helperCard(ctx, state, makeSnapshot());
      expect(kv(node).Version).toBe('abc1234 on main (tracks origin/main)');
      expect(kv(node)['Latest release']).toBe('v0.24.0');
      expect(kv(node).Available).toBeUndefined();
      expect(notes(node)).toEqual(['Already up to date.']);
      expect(button('Update now', node)).toBeUndefined();
    });

    it('leaves out the upstream and the release when there are none', () => {
      const { ctx } = fakeContext();
      state.updates = { status: status({ upstream: null, release: null }), error: null, checking: false, applied: false };
      const node = helperCard(ctx, state, makeSnapshot());
      expect(kv(node).Version).toBe('abc1234 on main');
      expect(kv(node)['Latest release']).toBeUndefined();
    });

    it('counts what an update brings, lists its commits, and offers to update', () => {
      const { ctx } = fakeContext();
      const commits = [
        { short: 'def5678', subject: 'Fix it' },
        { short: '9876543', subject: 'Tidy up' },
      ];
      state.updates = { status: status({ behind: 5, commits }), error: null, checking: false, applied: false };
      const node = helperCard(ctx, state, makeSnapshot());
      expect(kv(node).Available).toBe('5 new commits');
      expect([...node.querySelectorAll('.update-commit')].map((c) => c.textContent)).toEqual(['def5678  Fix it', '9876543  Tidy up', '…and 3 more']);
      expect(button('Update now', node).disabled).toBe(false);
    });

    it('offers no update, and says why, when the helper says it cannot', () => {
      const { ctx } = fakeContext();
      state.updates = {
        status: status({ behind: 1, commits: [{ short: 'def5678', subject: 'Fix it' }], canUpdate: false, reason: 'Local changes would be lost.' }),
        error: null,
        checking: false,
        applied: false,
      };
      const node = helperCard(ctx, state, makeSnapshot());
      expect(kv(node).Available).toBe('1 new commit');
      expect([...node.querySelectorAll('.settings-note.warn')].map((n) => n.textContent)).toEqual(['Local changes would be lost.']);
      const update = button('Update now', node);
      expect(update.disabled).toBe(true);
      expect(update.title).toBe('Local changes would be lost.');
    });

    it('says when a check failed, and keeps the check button', () => {
      const { ctx } = fakeContext();
      state.updates = { status: status(), error: 'no network', checking: false, applied: false };
      const node = helperCard(ctx, state, makeSnapshot());
      expect(kv(node).Version).toBe('abc1234');
      expect([...node.querySelectorAll('.settings-note.warn')].map((n) => n.textContent)).toEqual(['Could not check: no network']);
      expect(button('Check for updates', node)).toBeDefined();
    });
  });

  describe('applying an update', () => {
    it('asks twice, then tells the helper and remembers that it was applied', () => {
      const { ctx, requests, renders } = fakeContext();
      state.updates = { status: status({ behind: 1, commits: [{ short: 'def5678', subject: 'Fix it' }] }), error: null, checking: false, applied: false };
      const node = helperCard(ctx, state, makeSnapshot());
      button('Update now', node).click();
      expect(requests).toEqual([]);
      expect(button('Update, rebuild and restart?', helperCard(ctx, state, makeSnapshot()))).toBeDefined();
      button('Update now', node).click();
      expect(requests).toEqual([{ action: 'applyUpdate' }]);
      expect(state.updates.applied).toBe(true);
      expect(renders()).toBeGreaterThanOrEqual(2);
    });

    it('once applied, offers only to reload the extension, and reloads at one click', () => {
      const { ctx } = fakeContext();
      state.updates = { status: status({ behind: 1 }), error: null, checking: false, applied: true };
      const node = helperCard(ctx, state, makeSnapshot());
      expect(notes(node)).toEqual(['Updated. The helper is restarting, so every terminal ends; reload the extension to load the new panel.']);
      expect(button('Check for updates', node)).toBeUndefined();
      expect(button('Update now', node)).toBeUndefined();
      button('Reload extension', node).click();
      expect(fake.mock.runtime.reload).toHaveBeenCalledTimes(1);
    });
  });

  describe('the log', () => {
    it('asks for the log when shown, and stops asking when hidden', () => {
      const { ctx, sent, renders } = fakeContext();
      button('Show log', helperCard(ctx, state, makeSnapshot())).click();
      expect(state.logText).toBe('');
      expect(sent).toEqual([{ type: 'systemLog' }]);
      expect(renders()).toBe(1);

      const shown = helperCard(ctx, state, makeSnapshot());
      expect(shown.querySelector('.settings-log')!.textContent).toBe('Loading…');
      button('Hide log', shown).click();
      expect(state.logText).toBeNull();
      expect(sent).toHaveLength(1);
      expect(helperCard(ctx, state, makeSnapshot()).querySelector('.settings-log')).toBeNull();
    });

    it('shows the text once it has arrived', () => {
      const { ctx } = fakeContext();
      state.logText = 'line one\nline two';
      expect(helperCard(ctx, state, makeSnapshot()).querySelector('.settings-log')!.textContent).toBe('line one\nline two');
    });
  });

  describe('the helper process', () => {
    it('restarts and stops after asking twice, with stop marked dangerous', () => {
      const { ctx, requests } = fakeContext();
      const node = helperCard(ctx, state, makeSnapshot());
      button('Restart helper', node).click();
      button('Restart helper', node).click();
      const stop = button('Stop helper', node);
      expect(stop.classList.contains('danger')).toBe(true);
      stop.click();
      stop.click();
      expect(requests).toEqual([{ action: 'restartHelper' }, { action: 'stopHelper' }]);
    });

    it('cannot restart or stop a helper launchd does not manage, and says what to run', () => {
      const { ctx } = fakeContext();
      const node = helperCard(ctx, state, makeSnapshot({ helper: { ...makeSnapshot().helper, managed: false } }));
      for (const label of ['Restart helper', 'Stop helper']) {
        expect(button(label, node).disabled).toBe(true);
        expect(button(label, node).title).toContain('npm run agent:start');
      }
    });

    it('says whether the helper expects this extension, with the id it expects as the title', () => {
      const { ctx } = fakeContext();
      const matching = helperCard(ctx, state, makeSnapshot({ helper: { ...makeSnapshot().helper, extensionId: chrome.runtime.id } }));
      expect(kv(matching)['Extension ID']).toBe('Matches this extension');
      expect(matching.querySelector('.v .ok')).not.toBeNull();
      const other = helperCard(ctx, state, makeSnapshot({ helper: { ...makeSnapshot().helper, extensionId: 'other-id' } }));
      expect(kv(other)['Extension ID']).toBe(`Does not match this extension (${chrome.runtime.id})`);
      expect([...other.querySelectorAll('.kv')].find((l) => l.querySelector('.k')!.textContent === 'Extension ID')!.getAttribute('title')).toBe('other-id');
    });
  });

  describe('reviews and tools', () => {
    it('says when reviews were fetched, and the first line of the last error', () => {
      const { ctx } = fakeContext();
      const reviews = { fetchedAt: '2026-03-10T11:59:00.000Z', count: 3, error: 'gh: not logged in\nrun gh auth login' };
      const line = kv(helperCard(ctx, state, makeSnapshot({ reviews })))['Review requests'];
      expect(line).toMatch(/^3 PRs, fetched .+ \(last error: gh: not logged in\)$/);
      expect(kv(helperCard(ctx, state, makeSnapshot({ reviews: { fetchedAt: null, count: 0, error: null } })))['Review requests']).toBe('not fetched yet');
    });

    it('refreshes reviews and checks the GitHub CLI at one click', () => {
      const { ctx, sent, requests } = fakeContext();
      const node = helperCard(ctx, state, makeSnapshot());
      button('Refresh reviews', node).click();
      button('Check GitHub CLI', node).click();
      expect(sent).toEqual([{ type: 'refreshReviews' }]);
      expect(requests).toEqual([{ action: 'checkGh' }]);
    });

    it('copies debug info with the helper, storage and a sketch of each session, and nothing from the config', () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal('navigator', { clipboard: { writeText } });
      const { ctx, results } = fakeContext();
      const snapshot = makeSnapshot({ sessions: [makeSession({ id: 'ws-a', status: 'working', cwdMissing: true })] });
      button('Copy debug info', helperCard(ctx, state, snapshot)).click();
      const copied = JSON.parse(writeText.mock.calls[0]![0] as string);
      expect(copied).toEqual({
        extension: '1.2.3',
        helper: snapshot.helper,
        storage: snapshot.storage,
        sessions: [{ id: 'ws-a', pid: 100, status: 'working', cwdMissing: true }],
      });
      expect(JSON.stringify(copied)).not.toContain('/Users/me/prompts.md');
      expect(results).toEqual([{ ok: true, message: 'Debug info copied.' }]);
    });
  });
});
