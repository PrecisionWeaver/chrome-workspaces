import { describe, expect, it } from 'vitest';
import { MAX_PROMPT_LENGTH, MAX_TAB_URLS } from '../../../shared/protocol/protocol';
import { isControlToHelper } from './messages';

const ok = (message: unknown) => expect(isControlToHelper(message)).toBe(true);
const bad = (message: unknown) => expect(isControlToHelper(message)).toBe(false);

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
