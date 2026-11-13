// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlToClient } from '../../../shared/protocol/protocol';
import { installChrome } from '../../testing/chrome-mock';
import { loadPanelHtml, makeSnapshot, makeWorkspace } from '../../testing/fixtures';
import { createMessageHandler } from './messages';
import { createPanelState, type PanelState } from './state';

let state: PanelState;
let handle: (message: ControlToClient) => void;
let attachedId: string | null;
const windowId = 1;
const views = {
  creator: { setPrompts: vi.fn(), setTemplates: vi.fn(), setRepos: vi.fn(), setPrDetails: vi.fn(), setPrThreads: vi.fn() },
  git: {
    setState: vi.fn(),
    setCommit: vi.fn(),
    setDiff: vi.fn(),
    setResult: vi.fn(),
    setBranches: vi.fn(),
    setChecks: vi.fn(),
    setCompare: vi.fn(),
    refresh: vi.fn(),
  },
  settings: {
    setTimeline: vi.fn(),
    setUpdates: vi.fn(),
    setSystem: vi.fn(),
    setResult: vi.fn(),
    setLog: vi.fn(),
    download: vi.fn(),
    warningCount: 0,
    setupRemaining: 0,
  },
  activity: { setActivity: vi.fn() },
  workspaceList: { render: vi.fn(), showSessions: vi.fn() },
};
const session = { attachedId: () => attachedId, detach: vi.fn() };
const showNotice = vi.fn();
const render = vi.fn();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ws = (id: string, overrides = {}) => makeWorkspace({ id, name: `acme/${id}`, windowId, ...overrides });
const REVIEWS = { items: [], error: null, fetchedAt: null, refreshing: false };
const stateMessage = (workspaces = [ws('a')], statuses = {}): ControlToClient => ({ type: 'state', workspaces, statuses, waiting: {}, reviews: REVIEWS });

beforeEach(() => {
  installChrome();
  loadPanelHtml();
  for (const view of Object.values(views)) for (const fn of Object.values(view)) if (typeof fn === 'function') fn.mockClear();
  views.settings.warningCount = 0;
  views.settings.setupRemaining = 0;
  session.detach.mockClear();
  showNotice.mockClear();
  render.mockClear();
  attachedId = null;
  state = createPanelState();
  state.windowId = windowId;
  handle = createMessageHandler({ state, views, session, showNotice, render });
});

describe('routing', () => {
  it.each<[ControlToClient, () => ReturnType<typeof vi.fn>, unknown[]]>([
    [{ type: 'prompts', prompts: [], error: null }, () => views.creator.setPrompts, [[], null]],
    [{ type: 'templates', templates: [], error: 'bad' }, () => views.creator.setTemplates, [[], 'bad']],
    [{ type: 'repos', repos: [] }, () => views.creator.setRepos, [[]]],
    [{ type: 'prDetails', url: 'u', details: null, error: 'gone' }, () => views.creator.setPrDetails, ['u', null, 'gone']],
    [{ type: 'adminResult', action: 'restart', ok: true, message: 'done' }, () => views.settings.setResult, undefined as unknown as unknown[]],
    [{ type: 'systemLog', text: 'log' }, () => views.settings.setLog, ['log']],
    [{ type: 'exportData', json: '{}' }, () => views.settings.download, ['{}']],
    [{ type: 'git', id: 'a', state: null, error: null }, () => views.git.setState, undefined as unknown as unknown[]],
    [{ type: 'gitResult', id: 'a', action: 'commit', ok: true, message: '' }, () => views.git.setResult, undefined as unknown as unknown[]],
    [{ type: 'createError', name: 'acme/app', message: 'no such repo' }, () => showNotice, ['no such repo']],
  ])('sends %o to its view', (message, target, args) => {
    handle(message);
    const fn = target();
    expect(fn).toHaveBeenCalledTimes(1);
    if (args) expect(fn).toHaveBeenCalledWith(...args);
    else expect(fn).toHaveBeenCalledWith(message);
    expect(render).not.toHaveBeenCalled();
  });

  it('passes timeline, activity, updates, the other git answers, PR threads and sessions through whole', () => {
    const messages = [
      { type: 'timeline', id: 'a', entries: [], error: null },
      { type: 'activity', id: 'a', turns: [], error: null },
      { type: 'updates', info: null, error: null },
      { type: 'gitCommit', id: 'a', sha: 's', commit: null, error: null },
      { type: 'gitDiff', id: 'a', ref: null, path: 'p', diff: '', error: null },
      { type: 'gitBranches', id: 'a', branches: [], error: null },
      { type: 'gitChecks', id: 'a', branch: 'b', pr: null, checks: null, error: null },
      { type: 'gitCompare', id: 'a', base: 'main', files: [], error: null },
      { type: 'prThreads', url: 'u', threads: [], error: null },
      { type: 'sessions', id: 'a', sessions: [], error: null },
    ] as unknown as ControlToClient[];
    for (const message of messages) handle(message);
    expect(views.settings.setTimeline).toHaveBeenCalledWith(messages[0]);
    expect(views.activity.setActivity).toHaveBeenCalledWith(messages[1]);
    expect(views.settings.setUpdates).toHaveBeenCalledWith(messages[2]);
    expect(views.git.setCommit).toHaveBeenCalledWith(messages[3]);
    expect(views.git.setDiff).toHaveBeenCalledWith(messages[4]);
    expect(views.git.setBranches).toHaveBeenCalledWith(messages[5]);
    expect(views.git.setChecks).toHaveBeenCalledWith(messages[6]);
    expect(views.git.setCompare).toHaveBeenCalledWith(messages[7]);
    expect(views.creator.setPrThreads).toHaveBeenCalledWith(messages[8]);
    expect(views.workspaceList.showSessions).toHaveBeenCalledWith(messages[9]);
  });

  it('keeps the history and redraws the list', () => {
    const entries = [{ id: 'h', name: 'old/one', cwd: '/Users/me/acme', ticket: null, closedAt: '2026-01-01T00:00:00.000Z', resumeId: null }];
    handle({ type: 'history', entries } as unknown as ControlToClient);
    expect(state.history).toBe(entries);
    expect(views.workspaceList.render).toHaveBeenCalled();
  });
});

describe('a state message', () => {
  it('keeps what the helper sent and redraws', () => {
    const message = stateMessage([ws('a'), ws('b')], { a: 'working' });
    handle(message);
    expect(state.workspaces).toEqual([ws('a'), ws('b')]);
    expect(state.statuses).toEqual({ a: 'working' });
    expect(state.reviews).toBe(REVIEWS);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('notices a workspace joining this window', () => {
    const selectJoiners = vi.spyOn(state, 'selectJoiners');
    handle(stateMessage());
    expect(selectJoiners).toHaveBeenCalledWith([ws('a')]);
  });

  it('refreshes source control when claude starts or stops working, not otherwise', () => {
    handle(stateMessage([ws('a')], { a: 'idle' }));
    handle(stateMessage([ws('a')], { a: 'working' }));
    expect(views.git.refresh).toHaveBeenCalledTimes(1);
    handle(stateMessage([ws('a')], { a: 'working' }));
    expect(views.git.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('a system message', () => {
  it('learns the Jira site, and keeps it when a snapshot is missing', () => {
    const snapshot = makeSnapshot({ config: { ...makeSnapshot().config, jiraBaseUrl: 'https://jira.example.com' } });
    handle({ type: 'system', snapshot, error: null });
    expect(views.settings.setSystem).toHaveBeenCalled();
    expect(state.jiraBase).toBe('https://jira.example.com');
    handle({ type: 'system', snapshot: null, error: 'timeout' });
    expect(state.jiraBase).toBe('https://jira.example.com');
  });

  it('flags the settings button when something needs a look, and says how many', () => {
    views.settings.warningCount = 1;
    views.settings.setupRemaining = 1;
    handle({ type: 'system', snapshot: makeSnapshot(), error: null });
    expect($('settings-open').classList.contains('has-warning')).toBe(true);
    expect($('settings-open').title).toBe('Settings · 2 to look at');
    views.settings.warningCount = 0;
    views.settings.setupRemaining = 0;
    handle({ type: 'system', snapshot: makeSnapshot(), error: null });
    expect($('settings-open').classList.contains('has-warning')).toBe(false);
    expect($('settings-open').title).toBe('Settings');
  });

  it('rolls the helper and every workspace up into memory and CPU in the list header', () => {
    expect($('list-usage').hidden).toBe(true);
    const snapshot = makeSnapshot();
    const session = snapshot.sessions[0]!;
    handle({
      type: 'system',
      snapshot: { ...snapshot, sessions: [session, { ...session, processes: [{ ...session.processes[0]!, cpu: 3, rssKb: 1024 * 1024 }] }] },
      error: null,
    });
    // Helper 50 MB + 2 MB + 1 GB, and 1.5% + 0.1% + 3%.
    expect($('list-usage').hidden).toBe(false);
    expect($('list-usage').textContent).toBe('1.1 GB5%');
    expect($('list-usage').title).toContain('Helper 50.0 MB + workspaces 1.00 GB');
    handle({ type: 'system', snapshot: null, error: 'timeout' });
    expect($('list-usage').hidden).toBe(true);
  });
});

describe('a session reset', () => {
  it('detaches and redraws when it is the attached workspace’s', () => {
    attachedId = 'a';
    handle({ type: 'sessionReset', id: 'a' });
    expect(session.detach).toHaveBeenCalled();
    expect(render).toHaveBeenCalled();
  });

  it('is ignored for any other workspace', () => {
    attachedId = 'a';
    handle({ type: 'sessionReset', id: 'other' });
    expect(session.detach).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });
});
