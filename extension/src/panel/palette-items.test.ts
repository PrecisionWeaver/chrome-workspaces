// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChrome } from '../../testing/chrome-mock';
import { loadPanelHtml, makeHistoryEntry, makeReview, makeWorkspace } from '../../testing/fixtures';
import { createPaletteItems } from './palette-items';
import { createPanelState, type PanelState } from './state';

let fake: ReturnType<typeof installChrome>;
let state: PanelState;
let items: ReturnType<typeof createPaletteItems>;
const windowId = 1;
const deps = {
  send: vi.fn(() => true),
  creator: { show: vi.fn() },
  tools: { show: vi.fn(), showShell: vi.fn() },
  activity: { expand: vi.fn() },
  settings: { show: vi.fn() },
  git: { refresh: vi.fn() },
  workspaceList: { restore: vi.fn() },
  openWorkspace: vi.fn(),
  startReview: vi.fn(),
};
const ws = (id: string, overrides = {}) => makeWorkspace({ id, name: `acme/${id}`, windowId, ...overrides });
const labels = () => items().map((item) => `${item.kind}: ${item.label}`);
const run = (label: string) =>
  items()
    .find((item) => item.label === label)!
    .run();

beforeEach(() => {
  fake = installChrome();
  loadPanelHtml();
  for (const dep of Object.values(deps)) for (const fn of typeof dep === 'function' ? [dep] : Object.values(dep)) fn.mockClear();
  state = createPanelState();
  state.windowId = windowId;
  items = createPaletteItems({ state, ...deps });
});

describe('what is listed', () => {
  it('lists the actions, workspaces, tickets, archived workspaces and review requests', () => {
    state.jiraBase = 'https://jira.example.com';
    state.workspaces = [ws('a', { ticket: 'PROJ-123' })];
    state.statuses = { a: 'needs_input' };
    state.reviews = { items: [makeReview({ number: 12, title: 'Add it' })], error: null, fetchedAt: null, refreshing: false };
    state.history = [makeHistoryEntry({ name: 'old/one' })];
    expect(labels()).toEqual([
      'Action: New workspace',
      'Action: Terminal',
      'Action: Shell in acme/a',
      'Action: System monitor',
      'Action: Expand activity',
      'Action: Open settings',
      'Action: Refresh review requests',
      'Action: Refresh source control',
      'Action: Collapse the list',
      'Workspace: acme/a',
      'Ticket: PROJ-123 · acme/a',
      'Restore: old/one',
      'Review: app#12 Add it',
    ]);
    expect(items().find((item) => item.label === 'acme/a')!.hint).toBe('current · needs input · ~/acme');
  });

  it('offers no shell in a workspace, and no ticket, when there is none', () => {
    state.workspaces = [ws('a', { ticket: 'PROJ-123', windowId: null })];
    expect(labels()).not.toContain('Action: Shell in acme/a');
    expect(labels()).not.toContain('Ticket: PROJ-123 · acme/a');
    state.workspaces = [];
    expect(labels().filter((label) => label.startsWith('Workspace'))).toEqual([]);
  });

  it('says a review has a workspace, and opens that workspace rather than a new one', () => {
    const review = makeReview({ url: 'https://github.com/acme/app/pull/12' });
    state.workspaces = [ws('a', { pr: review.url })];
    state.reviews = { items: [review], error: null, fetchedAt: null, refreshing: false };
    expect(labels()).toContain('Review · has workspace: app#12 Add the thing');
    run('app#12 Add the thing');
    expect(deps.openWorkspace).toHaveBeenCalledWith(state.workspaces[0]);
    expect(deps.startReview).not.toHaveBeenCalled();
  });

  it('describes an idle workspace by its directory alone, and a restore by when it closed', () => {
    state.workspaces = [ws('a'), ws('b', { windowId: null })];
    state.statuses = { a: 'idle' };
    state.history = [makeHistoryEntry({ name: 'old/one', closedAt: '2026-03-01T12:00:00.000Z', resumeId: 's1' })];
    const hints = Object.fromEntries(items().map((item) => [item.label, item.hint]));
    expect(hints['acme/a']).toBe('current · ~/acme');
    expect(hints['acme/b']).toBe('~/acme');
    expect(hints['old/one']).toBe(`closed ${new Date('2026-03-01T12:00:00.000Z').toLocaleDateString()} · resumes its conversation`);
  });

  it('offers to expand the list once it is collapsed', () => {
    document.body.classList.add('collapsed');
    expect(labels()).toContain('Action: Expand the list');
  });
});

describe('running an item', () => {
  it('opens the view or sends the request each action stands for', () => {
    state.workspaces = [ws('a')];
    run('New workspace');
    expect(deps.creator.show).toHaveBeenCalled();
    run('Terminal');
    expect(deps.tools.show).toHaveBeenCalledWith('shell');
    run('Shell in acme/a');
    expect(deps.tools.showShell).toHaveBeenCalledWith(state.workspaces[0]);
    run('System monitor');
    expect(deps.tools.show).toHaveBeenCalledWith('monitor');
    run('Expand activity');
    expect(deps.activity.expand).toHaveBeenCalled();
    run('Open settings');
    expect(deps.settings.show).toHaveBeenCalled();
    run('Refresh review requests');
    expect(deps.send).toHaveBeenCalledWith({ type: 'refreshReviews' });
    run('Refresh source control');
    expect(deps.git.refresh).toHaveBeenCalled();
  });

  it('collapses the list through its button', () => {
    const clicked = vi.fn();
    document.getElementById('collapse')!.addEventListener('click', clicked);
    run('Collapse the list');
    expect(clicked).toHaveBeenCalled();
  });

  it('opens a workspace, a ticket in a tab, a restore, and a review without a workspace', async () => {
    const review = makeReview({ number: 3, title: 'Fix it' });
    const entry = makeHistoryEntry({ name: 'old/one' });
    state.jiraBase = 'https://jira.example.com';
    state.workspaces = [ws('a', { ticket: 'PROJ-123' })];
    state.history = [entry];
    state.reviews = { items: [review], error: null, fetchedAt: null, refreshing: false };
    run('acme/a');
    expect(deps.openWorkspace).toHaveBeenCalledWith(state.workspaces[0]);
    run('PROJ-123 · acme/a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.mock.tabs.create).toHaveBeenCalledWith({ url: 'https://jira.example.com/browse/PROJ-123' });
    run('old/one');
    expect(deps.workspaceList.restore).toHaveBeenCalledWith(entry);
    run('app#3 Fix it');
    expect(deps.startReview).toHaveBeenCalledWith(review);
  });
});
