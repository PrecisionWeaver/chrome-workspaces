import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ControlToClient } from '../../../shared/protocol/protocol';
import { connectControl, opened, startHarness, type Harness } from '../../testing/harness';
import { waitFor } from '../../testing/wait-for';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.close();
});

const PR = 'https://github.com/acme/web-app/pull/482';

describe('pull request requests', () => {
  it('sends the review threads of a pull request, and says why when it cannot', async () => {
    const { ws, messages } = connectControl(h);
    await opened(ws);
    const replies = () => messages.filter((m): m is Extract<ControlToClient, { type: 'prThreads' }> => m.type === 'prThreads');

    ws.send(JSON.stringify({ type: 'prThreads', url: PR }));
    await waitFor(() => replies().length === 1);
    expect(replies()[0]).toMatchObject({ threads: [], error: 'gh failed' });

    h.prThreadsJson = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              totalCount: 1,
              nodes: [
                {
                  isResolved: false,
                  isOutdated: false,
                  path: 'a.ts',
                  line: 4,
                  comments: {
                    nodes: [{ author: { login: 'drew' }, body: 'Rename this', createdAt: '2026-10-08T10:00:00Z', url: 'https://github.com/x/y/pull/1#r1' }],
                  },
                },
              ],
            },
          },
        },
      },
    });
    ws.send(JSON.stringify({ type: 'prThreads', url: PR }));
    await waitFor(() => replies().length === 2);
    expect(replies()[1]).toMatchObject({ error: null, total: 1, threads: [{ path: 'a.ts', line: 4, comments: [{ author: 'drew', body: 'Rename this' }] }] });
    // Both requests went out for the same PR, split into the parts gh is given.
    expect(h.prThreadRequests).toEqual(['acme/web-app#482', 'acme/web-app#482']);

    // A URL that is not a pull request never reaches gh.
    const before = h.prThreadRequests.length;
    ws.send(JSON.stringify({ type: 'prThreads', url: 'https://evil.example/a/b/pull/1' }));
    ws.send(JSON.stringify({ type: 'system' }));
    await waitFor(() => messages.some((m) => m.type === 'system'));
    expect(h.prThreadRequests).toHaveLength(before);
    ws.close();
  });

  it('answers prDetails to the asking client, reporting fetch errors and ignoring non-PR urls', async () => {
    h.prDetailsJson = JSON.stringify({
      number: 482,
      title: 't',
      url: PR,
      author: { login: 'drew' },
      headRefName: 'h',
      baseRefName: 'b',
      isDraft: false,
      additions: 1,
      deletions: 2,
      changedFiles: 3,
      reviewDecision: 'APPROVED',
      mergeable: 'MERGEABLE',
      createdAt: 'c',
      updatedAt: 'u',
      latestReviews: [],
      reviewRequests: [],
      statusCheckRollup: [],
    });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'prDetails', url: 'https://evil.example/o/r/pull/1' }));
    ws.send(JSON.stringify({ type: 'prDetails', url: PR }));
    await waitFor(() => messages.some((m) => m.type === 'prDetails'));
    expect(messages.filter((m) => m.type === 'prDetails')).toEqual([
      { type: 'prDetails', url: PR, details: expect.objectContaining({ title: 't', reviewDecision: 'APPROVED' }), error: null },
    ]);
    expect(h.prDetailsRequests).toEqual([PR]);

    h.prDetailsJson = null;
    ws.send(JSON.stringify({ type: 'prDetails', url: PR }));
    await waitFor(() => messages.filter((m) => m.type === 'prDetails').length === 2);
    expect(messages.filter((m) => m.type === 'prDetails')[1]).toEqual({ type: 'prDetails', url: PR, details: null, error: 'gh failed' });
    ws.close();
  });
});
