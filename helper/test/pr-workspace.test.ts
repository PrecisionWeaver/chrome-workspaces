import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReviewRequest } from '../../shared/protocol';
import { isPullRequestUrl, prWorkspace } from '../src/pr-workspace';

const URL = 'https://github.com/acme/web-app/pull/482';
const review: ReviewRequest = {
  repo: 'acme/web-app',
  number: 482,
  title: 'PROJ-9 - x',
  url: URL,
  author: 'drew',
  isDraft: false,
  updatedAt: '2026-10-01T00:00:00Z',
  ticket: 'PROJ-9',
  merge: 'unknown',
  mergeReason: null,
  needsReReview: false,
  approved: false,
  ci: null,
};
const defaultCwd = mkdtempSync(join(tmpdir(), 'cw-default-'));
const repoDir = mkdtempSync(join(tmpdir(), 'cw-repo-'));

describe('isPullRequestUrl', () => {
  it('accepts only github.com pull request urls', () => {
    expect(isPullRequestUrl(URL)).toBe(true);
    expect(isPullRequestUrl(`${URL}/files`)).toBe(false);
    expect(isPullRequestUrl('https://evil.example/o/r/pull/1')).toBe(false);
    expect(isPullRequestUrl('https://github.com/o/r/issues/1')).toBe(false);
  });
});

describe('prWorkspace', () => {
  it('names the workspace repo#number, opens the PR, and takes the ticket from the review list', () => {
    expect(prWorkspace(URL, { reviews: [review], repoDirs: {}, defaultCwd })).toEqual({
      name: 'web-app#482',
      ticket: 'PROJ-9',
      cwd: defaultCwd,
      url: URL,
      pr: URL,
    });
  });

  it('starts in the mapped repo directory when it exists', () => {
    expect(prWorkspace(URL, { reviews: [], repoDirs: { 'acme/web-app': repoDir }, defaultCwd }).cwd).toBe(repoDir);
    expect(prWorkspace(URL, { reviews: [], repoDirs: { 'acme/web-app': join(repoDir, 'gone') }, defaultCwd }).cwd).toBe(defaultCwd);
  });

  it('has no ticket for a PR outside the review list', () => {
    expect(prWorkspace(URL, { reviews: [], repoDirs: {}, defaultCwd }).ticket).toBeNull();
  });
});
