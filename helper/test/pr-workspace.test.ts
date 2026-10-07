import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReviewRequest } from '../../shared/protocol';
import { isPullRequestUrl, prWorkspace } from '../src/pr-workspace';

const URL = 'https://github.com/vorys-econtrol/pec-platform/pull/482';
const review: ReviewRequest = {
  repo: 'vorys-econtrol/pec-platform',
  number: 482,
  title: 'ORC-9 - x',
  url: URL,
  author: 'drew',
  isDraft: false,
  updatedAt: '2026-10-01T00:00:00Z',
  ticket: 'ORC-9',
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
      name: 'pec-platform#482',
      ticket: 'ORC-9',
      cwd: defaultCwd,
      url: URL,
      pr: URL,
    });
  });

  it('starts in the mapped repo directory when it exists', () => {
    expect(prWorkspace(URL, { reviews: [], repoDirs: { 'vorys-econtrol/pec-platform': repoDir }, defaultCwd }).cwd).toBe(repoDir);
    expect(prWorkspace(URL, { reviews: [], repoDirs: { 'vorys-econtrol/pec-platform': join(repoDir, 'gone') }, defaultCwd }).cwd).toBe(defaultCwd);
  });

  it('has no ticket for a PR outside the review list', () => {
    expect(prWorkspace(URL, { reviews: [], repoDirs: {}, defaultCwd }).ticket).toBeNull();
  });
});
