import { describe, expect, it } from 'vitest';
import { type AdminAction, type ClientMessage, type ControlToHelper, MAX_PROMPT_LENGTH, MAX_TAB_URLS } from '../../../shared/protocol/protocol';
import { isClientMessage, isControlToHelper } from './messages';

const ok = (message: unknown) => expect(isControlToHelper(message)).toBe(true);
const bad = (message: unknown) => expect(isControlToHelper(message)).toBe(false);

describe('isClientMessage', () => {
  it('accepts the three terminal messages and rejects anything malformed', () => {
    expect(isClientMessage({ type: 'input', data: 'ls\r' })).toBe(true);
    expect(isClientMessage({ type: 'resize', cols: 80, rows: 24 })).toBe(true);
    expect(isClientMessage({ type: 'file', name: 'a.png', data: 'AAAA' })).toBe(true);
    for (const message of [null, 42, {}, { type: 'input' }, { type: 'file', name: 'a.png' }, { type: 'exit', code: 0 }])
      expect(isClientMessage(message)).toBe(false);
  });

  it('rejects a terminal size node-pty would throw on', () => {
    for (const [cols, rows] of [
      [0, 24],
      [80, -1],
      [80.5, 24],
      ['80', 24],
      [80, Number.NaN],
      [80, 5000],
    ]) {
      expect(isClientMessage({ type: 'resize', cols, rows })).toBe(false);
    }
  });
});

describe('isControlToHelper', () => {
  it('rejects anything that is not an object with a known type', () => {
    bad(null);
    bad('pair');
    bad({});
    bad({ type: 'unknown' });
  });

  it('checks window and group ids are integers', () => {
    ok({ type: 'pair', id: 'ws1', windowId: 3 });
    ok({ type: 'pair', id: 'ws1', windowId: 3, groupId: 7 });
    bad({ type: 'pair', id: 'ws1', windowId: '3' });
    bad({ type: 'pair', id: 'ws1', windowId: 3, groupId: 1.5 });
    ok({ type: 'unpair', windowId: 3 });
    bad({ type: 'unpair' });
    ok({ type: 'tabs', windowId: 3, urls: ['https://example.com'] });
    bad({ type: 'tabs', windowId: 3, urls: [1] });
    ok({ type: 'tabs', windowId: 3, urls: Array.from({ length: 500 }, (_, n) => `https://example.com/${n}`) });
    bad({ type: 'tabs', windowId: 3, urls: Array.from({ length: 501 }, (_, n) => `https://example.com/${n}`) });
    bad({ type: 'tabs', windowId: 3, urls: [`https://example.com/${'a'.repeat(4100)}`] });
  });

  it('bounds a workspace name', () => {
    ok({ type: 'rename', id: 'ws1', name: 'Acme app' });
    bad({ type: 'rename', id: 'ws1', name: '   ' });
    bad({ type: 'rename', id: 'ws1', name: 'x'.repeat(81) });
  });

  it('validates every field of a create request', () => {
    ok({ type: 'create', name: 'Acme app', windowId: null });
    ok({
      type: 'create',
      name: 'Acme app',
      windowId: 2,
      pr: 'https://github.com/acme/app/pull/12',
      prompt: 'hi',
      cwd: '/Users/me/acme',
      model: 'sonnet',
      color: 'blue',
      group: true,
      urls: ['https://example.com'],
      worktree: 'feat/PROJ-123',
    });
    bad({ type: 'create', name: 'Acme app', windowId: null, pr: 'https://example.com/not-a-pr' });
    bad({ type: 'create', name: 'Acme app', windowId: null, prompt: 'p'.repeat(MAX_PROMPT_LENGTH + 1) });
    bad({ type: 'create', name: 'Acme app', windowId: null, model: 'not a model' });
    bad({ type: 'create', name: 'Acme app', windowId: null, color: 'mauve' });
    bad({ type: 'create', name: 'Acme app', windowId: null, urls: Array.from({ length: MAX_TAB_URLS + 1 }, () => 'https://example.com') });
    bad({ type: 'create', name: 'Acme app', windowId: null, urls: ['ftp://example.com'] });
    bad({ type: 'create', name: 'Acme app', windowId: null, worktree: 'bad branch' });
  });

  it('limits mark to the known colours and a boolean pin', () => {
    ok({ type: 'mark', id: 'ws1', pinned: true });
    ok({ type: 'mark', id: 'ws1', color: null });
    bad({ type: 'mark', id: 'ws1', pinned: 'yes' });
    bad({ type: 'mark', id: 'ws1', color: 'mauve' });
  });

  it('bounds text sent to a session and the order list', () => {
    ok({ type: 'sendText', id: 'ws1', text: 'ls' });
    bad({ type: 'sendText', id: 'ws1', text: '' });
    bad({ type: 'sendText', id: 'ws1', text: 'x'.repeat(100_001) });
    ok({ type: 'order', ids: ['a', 'b'] });
    bad({ type: 'order', ids: ['a', 2] });
    ok({ type: 'move', id: 'ws1', index: 0 });
    bad({ type: 'move', id: 'ws1', index: -1 });
  });

  it('checks a resumed session id is a uuid', () => {
    ok({ type: 'resumeSession', id: 'ws1', sessionId: '0f1e2d3c-4b5a-4968-8776-655443322110' });
    bad({ type: 'resumeSession', id: 'ws1', sessionId: 'latest' });
    ok({ type: 'activity', id: null });
    ok({ type: 'listSessions', id: 'ws1' });
  });

  it('accepts only the admin actions it knows, with their arguments', () => {
    ok({ type: 'admin', request: { action: 'restartHelper' } });
    ok({ type: 'admin', request: { action: 'restartSession', id: 'ws1' } });
    ok({ type: 'admin', request: { action: 'killProcess', id: 'ws1', pid: 42, force: true } });
    bad({ type: 'admin', request: { action: 'killProcess', id: 'ws1', pid: 1 } });
    bad({ type: 'admin', request: { action: 'killProcess', id: 'ws1', pid: 42, force: 'yes' } });
    bad({ type: 'admin', request: { action: 'restartSession' } });
    bad({ type: 'admin', request: { action: 'rm -rf' } });
    bad({ type: 'admin', request: null });
  });

  it('validates git requests', () => {
    ok({ type: 'git', id: 'ws1' });
    ok({ type: 'gitCommit', id: 'ws1', sha: 'abcdef1' });
    bad({ type: 'gitCommit', id: 'ws1', sha: 'HEAD' });
    ok({ type: 'gitDiff', id: 'ws1', path: 'src/a.ts' });
    ok({ type: 'gitDiff', id: 'ws1', path: 'src/a.ts', sha: 'abcdef1', base: true });
    bad({ type: 'gitDiff', id: 'ws1', path: '' });
    bad({ type: 'gitDiff', id: 'ws1', path: 'src/a.ts', sha: 'main' });
    ok({ type: 'gitStage', id: 'ws1', stage: true, paths: ['a'] });
    bad({ type: 'gitStage', id: 'ws1', stage: 'yes', paths: ['a'] });
    bad({ type: 'gitDiscard', id: 'ws1', paths: [''] });
    ok({ type: 'gitSave', id: 'ws1', message: 'fix' });
    bad({ type: 'gitSave', id: 'ws1', message: 'x'.repeat(10_001) });
    ok({ type: 'gitSwitch', id: 'ws1', branch: 'main' });
    bad({ type: 'gitSwitch', id: 'ws1', branch: '' });
    for (const type of ['gitBranches', 'gitChecks', 'gitCompare', 'gitPush', 'gitCreatePr']) {
      ok({ type, id: 'ws1' });
      bad({ type });
    }
  });

  it('requires a pull request url for PR details', () => {
    ok({ type: 'prDetails', url: 'https://github.com/acme/app/pull/12' });
    bad({ type: 'prThreads', url: 'https://github.com/acme/app' });
  });

  it('takes the argument-free requests as they are', () => {
    for (const type of ['forgetAll', 'system', 'systemLog', 'exportData', 'checkUpdates', 'listPrompts', 'listTemplates', 'listRepos', 'refreshReviews']) {
      ok({ type });
    }
  });
});

// One valid message of every kind. The mapped types make a kind added to the protocol a type error here until it has
// a sample, and the tests below fail until the validator accepts it, so the two cannot drift apart unnoticed.
const WS = 'ws-0123abcd';
const PR = 'https://github.com/acme/app/pull/7';

const CLIENT_SAMPLES: { [T in ClientMessage['type']]: Extract<ClientMessage, { type: T }> } = {
  input: { type: 'input', data: 'ls\r' },
  resize: { type: 'resize', cols: 80, rows: 24 },
  file: { type: 'file', name: 'a.png', data: 'AAAA' },
};

const ADMIN_SAMPLES: { [A in AdminAction['action']]: AdminAction & { action: A } } = {
  restartSession: { action: 'restartSession', id: WS },
  killProcess: { action: 'killProcess', id: WS, pid: 4321, force: true },
  applyUpdate: { action: 'applyUpdate' },
  restartHelper: { action: 'restartHelper' },
  stopHelper: { action: 'stopHelper' },
  clearUploads: { action: 'clearUploads' },
  clearLog: { action: 'clearLog' },
  pruneWorktrees: { action: 'pruneWorktrees' },
  checkGh: { action: 'checkGh' },
};

const CONTROL_SAMPLES: { [T in ControlToHelper['type']]: Extract<ControlToHelper, { type: T }> } = {
  pair: { type: 'pair', id: WS, windowId: 1, groupId: 2 },
  unpair: { type: 'unpair', windowId: 1 },
  unpairGroup: { type: 'unpairGroup', groupId: 2 },
  tabs: { type: 'tabs', windowId: 1, urls: ['https://a.example/'], groupId: 2 },
  create: {
    type: 'create',
    name: 'PROJ-123',
    windowId: null,
    pr: PR,
    prompt: 'go',
    cwd: '/Users/me/code/app',
    model: 'opus',
    color: 'blue',
    group: true,
    urls: ['https://a.example/'],
    worktree: 'PROJ-123',
  },
  remove: { type: 'remove', id: WS, closeTabs: true },
  rename: { type: 'rename', id: WS, name: 'renamed' },
  mark: { type: 'mark', id: WS, pinned: true, color: null },
  move: { type: 'move', id: WS, index: 0 },
  order: { type: 'order', ids: [WS] },
  restore: { type: 'restore', historyId: 'h-0123abcd', windowId: null },
  forget: { type: 'forget', historyId: 'h-0123abcd' },
  forgetAll: { type: 'forgetAll' },
  sendText: { type: 'sendText', id: WS, text: 'hello' },
  listSessions: { type: 'listSessions', id: WS },
  resumeSession: { type: 'resumeSession', id: WS, sessionId: '11111111-2222-3333-4444-555555555555' },
  listPrompts: { type: 'listPrompts' },
  listTemplates: { type: 'listTemplates' },
  listRepos: { type: 'listRepos' },
  system: { type: 'system' },
  admin: { type: 'admin', request: { action: 'checkGh' } },
  systemLog: { type: 'systemLog' },
  checkUpdates: { type: 'checkUpdates' },
  timeline: { type: 'timeline', id: WS },
  activity: { type: 'activity', id: null },
  exportData: { type: 'exportData' },
  git: { type: 'git', id: WS },
  gitCommit: { type: 'gitCommit', id: WS, sha: 'abc1234' },
  gitDiff: { type: 'gitDiff', id: WS, path: 'a.txt', sha: 'abc1234', base: false },
  gitStage: { type: 'gitStage', id: WS, paths: ['a.txt'], stage: true },
  gitDiscard: { type: 'gitDiscard', id: WS, paths: ['a.txt'] },
  gitSave: { type: 'gitSave', id: WS, message: 'fix' },
  gitBranches: { type: 'gitBranches', id: WS },
  gitChecks: { type: 'gitChecks', id: WS },
  gitSwitch: { type: 'gitSwitch', id: WS, branch: 'main' },
  gitPush: { type: 'gitPush', id: WS },
  gitCreatePr: { type: 'gitCreatePr', id: WS },
  gitCompare: { type: 'gitCompare', id: WS },
  refreshReviews: { type: 'refreshReviews' },
  prDetails: { type: 'prDetails', url: PR },
  prThreads: { type: 'prThreads', url: PR },
};

describe('every message in the protocol has a validator', () => {
  it.each(Object.values(CLIENT_SAMPLES))('accepts a terminal $type', (message) => expect(isClientMessage(message)).toBe(true));
  it.each(Object.values(CONTROL_SAMPLES))('accepts a control $type', ok);
  it.each(Object.values(ADMIN_SAMPLES))('accepts the admin action $action', (request) => ok({ type: 'admin', request }));
});
