import { readFileSync } from 'node:fs';
import { afterEach, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import type { HistoryEntry, PrDetails, ReviewRequest, SystemSession, SystemSnapshot, UsageDay, UsageHour, Workspace } from '../../shared/protocol';

/** A workspace with everything unset; tests override what they care about. */
export function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-00000001',
    name: 'acme/app',
    ticket: null,
    cwd: '/Users/me/acme',
    url: null,
    windowId: null,
    groupId: null,
    pinned: false,
    color: null,
    resume: null,
    model: null,
    lastTabUrls: [],
    pr: null,
    prompt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** A pull request's details with nothing notable about it; tests override what they care about. */
export function makePrDetails(overrides: Partial<PrDetails> = {}): PrDetails {
  return {
    url: 'https://github.com/acme/app/pull/12',
    title: 'Add the thing',
    author: 'octocat',
    head: 'feature/thing',
    base: 'main',
    isDraft: false,
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    reviews: [],
    requested: [],
    checks: { passed: 0, failed: 0, pending: 0, failing: [] },
    body: '',
    labels: [],
    comments: 0,
    files: [],
    commits: [],
    commitCount: 0,
    ...overrides,
  };
}

/** Puts the real side panel markup in the page, so the ids the views look up are the ones the extension ships. */
export function loadPanelHtml(): void {
  const html = readFileSync(resolve(__dirname, '../panel.html'), 'utf8');
  // The page outlives a test, so what the panel set on it goes too.
  document.body.removeAttribute('class');
  document.body.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');
}

/** A review request for a ready-to-review PR; tests override what they care about. */
export function makeReview(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    repo: 'acme/app',
    number: 12,
    title: 'Add the thing',
    url: 'https://github.com/acme/app/pull/12',
    author: 'octocat',
    isDraft: false,
    updatedAt: new Date().toISOString(),
    ticket: null,
    merge: 'review',
    mergeReason: null,
    needsReReview: false,
    ci: null,
    ...overrides,
  };
}

/**
 * Views register listeners on `document` and never remove them, since the panel lives as long as its page.
 * Call this in a test file to have each test's listeners removed afterwards, so one test's view cannot answer another's events.
 */
export function isolateDocumentListeners(): void {
  let added: [string, EventListenerOrEventListenerObject, unknown][] = [];
  const original = document.addEventListener.bind(document);
  beforeEach(() => {
    added = [];
    document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: unknown) => {
      added.push([type, listener, options]);
      original(type, listener, options as AddEventListenerOptions);
    }) as typeof document.addEventListener;
  });
  afterEach(() => {
    for (const [type, listener, options] of added) document.removeEventListener(type, listener, options as EventListenerOptions);
    document.addEventListener = original;
  });
}

export function makeSession(overrides: Partial<SystemSession> = {}): SystemSession {
  return {
    id: 'ws-00000001',
    name: 'acme/app',
    pid: 100,
    status: null,
    cwd: '/Users/me/acme',
    cwdMissing: false,
    claudeSessionId: null,
    tokens: null,
    processes: [{ pid: 100, ppid: 1, command: '-zsh', cpu: 0.1, rssKb: 2048, elapsed: '01:00', ports: [] }],
    ...overrides,
  };
}

/** One quiet day of usage; tests set what they care about. */
export function makeUsageDay(overrides: Partial<UsageDay> = {}): UsageDay {
  return { day: '2026-03-10', tokens: 0, costUsd: 0, output: 0, cacheRead: 0, models: [], ...overrides };
}

/** A day of quiet hours, 0 to 23; tests set the ones they care about. */
export function makeUsageHours(used: Record<number, { tokens: number; costUsd?: number }> = {}): UsageHour[] {
  return Array.from({ length: 24 }, (_, hour) => ({ hour, tokens: used[hour]?.tokens ?? 0, costUsd: used[hour]?.costUsd ?? 0 }));
}

/** A healthy, fully set up install, so every setup step is done; tests break what they care about. */
export function makeSnapshot(overrides: Partial<SystemSnapshot> = {}): SystemSnapshot {
  return {
    takenAt: '2026-03-10T12:00:00.000Z',
    helper: {
      pid: 42,
      uptimeSec: 3700,
      rssKb: 51_200,
      port: 4000,
      node: 'v22.18.0',
      commit: 'abc1234',
      managed: true,
      clients: 2,
      logPath: '/Users/me/.chrome-workspaces/helper.log',
      configPath: '/Users/me/.chrome-workspaces/config.json',
      extensionId: 'ext-id',
    },
    sessions: [makeSession()],
    storage: { uploadsBytes: 0, logBytes: 2048, dataBytes: 4096 },
    config: {
      defaultCwd: '/Users/me',
      promptsFile: '/Users/me/prompts.md',
      defaultModel: null,
      claudeCommand: 'claude',
      repoRoots: ['/Users/me/code'],
      repoDirs: {},
      watchRepos: [],
      limits: { memoryWarnMb: 4096, idleServerHours: 4 },
      pricing: { opus: { input: 15, output: 75 } },
      jiraBaseUrl: null,
    },
    usage: { daily: [makeUsageDay({ day: '2026-03-10' })], hourly: makeUsageHours(), costUsd: 0, counting: false, unpriced: [] },
    warnings: [],
    reviews: { fetchedAt: '2026-03-10T11:59:00.000Z', count: 3, error: null },
    setup: { promptsFileExists: true, repoRoots: [{ path: '/Users/me/code', exists: true }], statusHooks: true, configProblems: [] },
    ...overrides,
  };
}

export function makeHistoryEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'h-1',
    name: 'old/work',
    cwd: '/Users/me/acme',
    ticket: null,
    url: null,
    pr: null,
    model: null,
    tabs: [],
    pinned: false,
    color: null,
    resumeId: null,
    closedAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}
