// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminAction, ControlToHelper } from '../../../shared/protocol/protocol';
import { makeSnapshot } from '../../testing/fixtures';
import { createArming } from '../ui/dom';
import { configCard, dataCard } from './settings-data';
import type { SettingsContext } from './settings-parts';

const sent: ControlToHelper[] = [];
const requests: AdminAction[] = [];
let ctx: SettingsContext;

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  requests.length = 0;
  ctx = {
    send: (message) => (sent.push(message), true),
    request: (action) => void requests.push(action),
    render: () => {},
    showResult: () => {},
    arming: createArming(() => {}, 4000),
  };
});
afterEach(() => vi.useRealTimers());

const button = (root: HTMLElement, label: string) => [...root.querySelectorAll('button')].find((b) => b.textContent === label)!;

describe('dataCard', () => {
  it('shows what uploads, the log and the data folder take', () => {
    const base = makeSnapshot();
    const card = dataCard(ctx, { ...base, storage: { uploadsBytes: 2048, logBytes: 512, dataBytes: 3 * 1024 * 1024 } });
    expect(card.dataset.key).toBe('Data');
    const values = [...card.querySelectorAll('.kv')].map((line) => [line.querySelector('.k')!.textContent, line.querySelector('.v')!.textContent]);
    expect(values).toEqual([
      ['Uploads', '2.0 KB'],
      ['Helper log', '512 B'],
      ['Data folder', '3.0 MB'],
    ]);
  });

  it('asks twice before clearing uploads or the log, and once to prune or export', () => {
    const snapshot = makeSnapshot();
    // The view draws the card again after the first press; the arming it keeps is what turns the label into the question.
    const press = (first: string, second: string) => {
      button(dataCard(ctx, snapshot), first).click();
      const before = requests.length;
      button(dataCard(ctx, snapshot), second).click();
      return requests.slice(before);
    };
    expect(press('Clear uploads', 'Delete all uploads?')).toEqual([{ action: 'clearUploads' }]);
    expect(press('Clear log', 'Empty the log?')).toEqual([{ action: 'clearLog' }]);
    button(dataCard(ctx, snapshot), 'Prune worktrees').click();
    expect(requests.at(-1)).toEqual({ action: 'pruneWorktrees' });
    button(dataCard(ctx, snapshot), 'Export workspaces').click();
    expect(sent).toEqual([{ type: 'exportData' }]);
  });
});

describe('configCard', () => {
  it('shows the effective config, and says where it was read from', () => {
    const snapshot = makeSnapshot();
    const card = configCard(
      {
        ...snapshot,
        config: { ...snapshot.config, defaultCwd: '/Users/me', claudeArgs: ['--verbose'], defaultModel: null, repoDirs: { 'acme/app': '/code/app' } },
      },
      () => {},
    );
    expect(card.dataset.key).toBe('Configuration');
    expect(card.textContent).toContain(`Read from ${snapshot.helper.configPath}`);
    expect(card.textContent).toContain('/Users/me');
    expect(card.textContent).toContain('--verbose');
    expect(card.textContent).toContain("claude's own");
    expect(card.textContent).toContain('acme/app → /code/app');
  });

  it('lists the entries the helper ignored, in red, only when there are some', () => {
    const snapshot = makeSnapshot();
    expect(configCard(snapshot, () => {}).querySelector('.bad')).toBeNull();
    const card = configCard({ ...snapshot, setup: { ...snapshot.setup, configProblems: ['defaultModel is not a model name.'] } }, () => {});
    expect(card.querySelector('.bad')?.textContent).toBe('defaultModel is not a model name.');
  });

  it('has an Edit button that opens the editor', () => {
    const edited: string[] = [];
    const card = configCard(makeSnapshot(), () => edited.push('edit'));
    button(card, 'Edit').click();
    expect(edited).toEqual(['edit']);
  });
});
