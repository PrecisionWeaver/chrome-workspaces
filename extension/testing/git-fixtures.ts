import { vi } from 'vitest';
import type { ControlToHelper, GitCommit, GitFile, GitState, WaitingOn, WorkspaceStatus } from '../../shared/protocol/protocol';
import { createGitView, type GitView } from '../src/source-control/git-view';
import { closeMenu } from '../src/ui/menu';
import { installChrome } from './chrome-mock';
import { loadPanelHtml, makeWorkspace } from './fixtures';

/** The instant the git view tests run at; commits are dated back from it. */
export const GIT_NOW = Date.parse('2026-03-10T12:00:00.000Z');

export const gitFile = (path: string, index = ' ', worktree = 'M', from?: string): GitFile => ({ path, index, worktree, ...(from ? { from } : {}) });

export const gitCommit = (n: number, overrides: Partial<GitCommit> = {}): GitCommit => ({
  sha: `sha${n}`,
  short: `abc${n}`,
  author: 'octocat',
  date: new Date(GIT_NOW - n * 3_600_000).toISOString(),
  refs: [],
  parents: [`sha${n + 1}`],
  subject: `Commit ${n}`,
  ...overrides,
});

/** A clean checkout of main; tests override what they care about. */
export const gitState = (overrides: Partial<GitState> = {}): GitState => ({
  root: '/Users/me/acme',
  worktree: null,
  branch: 'main',
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  files: [],
  commits: [],
  ...overrides,
});

export interface GitViewHarness {
  view: GitView;
  fake: ReturnType<typeof installChrome>;
  /** Every message the view sent to the helper. */
  sent: ControlToHelper[];
  /** How many times the view told the panel the diff view opened or closed. */
  toggled: number;
  statuses: Record<string, WorkspaceStatus>;
  waiting: Record<string, WaitingOn>;
  archived: string[];
  sentOfType<T extends ControlToHelper['type']>(type: T): Extract<ControlToHelper, { type: T }>[];
  /** Answers a status request, for `ws-a` unless told otherwise. */
  setState(state: GitState | null, error?: string | null, id?: string): void;
  /**
   * Points the view at `ws-a` with its first answer in, and forgets the requests that took out of the way.
   * A first answer names the branch, which asks again at once for that branch's checks, so a second answers that.
   */
  ready(state?: GitState | null): Promise<void>;
}

/** The workspace the harness points the view at. */
export const GIT_WORKSPACE = makeWorkspace({ id: 'ws-a' });

/** A git view on the shipped markup, recording what it sends and tells the panel. Fake timers must be on, and the time set to `GIT_NOW`. */
export function mountGitView(): GitViewHarness {
  const fake = installChrome();
  loadPanelHtml();
  closeMenu();
  const harness: GitViewHarness = {
    view: undefined as unknown as GitView,
    fake,
    sent: [],
    toggled: 0,
    statuses: {},
    waiting: {},
    archived: [],
    sentOfType: (type) => harness.sent.filter((message): message is Extract<ControlToHelper, { type: typeof type }> => message.type === type),
    setState: (state, error = null, id = 'ws-a') => harness.view.setState({ type: 'git', id, state, error }),
    async ready(state = gitState()) {
      harness.view.setWorkspace(GIT_WORKSPACE);
      await vi.advanceTimersByTimeAsync(0);
      harness.setState(state);
      harness.setState(state);
      harness.sent.length = 0;
    },
  };
  harness.view = createGitView({
    send: (message) => (harness.sent.push(message), true),
    onToggle: () => void harness.toggled++,
    status: (id) => harness.statuses[id] ?? null,
    waiting: (id) => harness.waiting[id] ?? null,
    archive: (id) => harness.archived.push(id),
  });
  return harness;
}
