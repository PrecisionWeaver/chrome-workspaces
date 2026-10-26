// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrThread, ReviewRequest } from '../../shared/protocol';
import { byline, ref, relative, renderDetails, renderThreads, repoName } from '../src/pr-view';
import { installChrome } from './chrome-mock';
import { makePrDetails } from './fixtures';

const NOW = Date.parse('2026-03-10T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const mount = (nodes: Node[]) => {
  const host = document.createElement('div');
  host.append(...nodes);
  document.body.replaceChildren(host);
  return host;
};
const text = (host: ParentNode, selector: string) => [...host.querySelectorAll(selector)].map((node) => node.textContent);

describe('names', () => {
  it('shows a review request as repo#number, without the owner', () => {
    const review = { repo: 'acme/app', number: 12 } as ReviewRequest;
    expect(repoName(review)).toBe('app');
    expect(ref(review)).toBe('app#12');
  });

  it('copes with a repo that has no owner', () => {
    expect(repoName({ repo: 'app' } as ReviewRequest)).toBe('app');
  });
});

describe('relative', () => {
  it.each([
    [0, '1m ago'],
    [30 * 1000, '1m ago'],
    [5 * MINUTE, '5m ago'],
    [59 * MINUTE, '59m ago'],
    [90 * MINUTE, '2h ago'],
    [47 * HOUR, '47h ago'],
    [72 * HOUR, '3d ago'],
  ])('%i ms ago reads %s', (elapsed, expected) => {
    expect(relative(ago(elapsed))).toBe(expected);
  });
});

describe('byline', () => {
  it('leads with the author in bold', () => {
    const line = byline('opened 2h ago', 'octocat', 'by ');
    expect(line.className).toBe('when');
    expect(line.textContent).toBe('by octocat · opened 2h ago');
    expect(line.querySelector('strong.author')?.textContent).toBe('octocat');
  });
});

describe('renderDetails', () => {
  it('shows the branches, size, author and ages', () => {
    const host = mount(
      renderDetails(
        makePrDetails({
          head: 'feature/x',
          base: 'main',
          additions: 1234,
          deletions: 5,
          changedFiles: 3,
          createdAt: ago(3 * HOUR),
          updatedAt: ago(10 * MINUTE),
        }),
      ),
    );
    expect(text(host, '.branches code')).toEqual(['feature/x', 'main']);
    expect(text(host, '.stats .add')).toEqual(['+1,234']);
    expect(text(host, '.stats .del')).toEqual(['−5']);
    expect(text(host, '.stats .files')).toEqual(['3 files']);
    expect(host.querySelector('.stats .when')?.textContent).toBe('by octocat · opened 3h ago · updated 10m ago');
  });

  it('counts conversation comments, and shows none when there are none', () => {
    expect(text(mount(renderDetails(makePrDetails({ comments: 1 }))), '.comments')).toEqual(['1 comment']);
    expect(text(mount(renderDetails(makePrDetails({ comments: 4 }))), '.comments')).toEqual(['4 comments']);
    expect(mount(renderDetails(makePrDetails())).querySelector('.comments')).toBeNull();
  });

  describe('status pills', () => {
    const pills = (overrides: Parameters<typeof makePrDetails>[0]) => text(mount(renderDetails(makePrDetails(overrides))), '.pill');
    const tones = (overrides: Parameters<typeof makePrDetails>[0]) =>
      [...mount(renderDetails(makePrDetails(overrides))).querySelectorAll('.pill')].map((pill) => pill.className.replace('pill', '').trim());

    it('names the review decision, with a tone', () => {
      expect(pills({ reviewDecision: 'APPROVED' })).toEqual(['Approved']);
      expect(tones({ reviewDecision: 'APPROVED' })).toEqual(['good']);
      expect(pills({ reviewDecision: 'CHANGES_REQUESTED' })).toEqual(['Changes requested']);
      expect(tones({ reviewDecision: 'CHANGES_REQUESTED' })).toEqual(['bad']);
      expect(tones({ reviewDecision: 'REVIEW_REQUIRED' })).toEqual(['wait']);
    });

    it('says no review is required when there is no decision', () => {
      expect(pills({ reviewDecision: null })).toEqual(['No review required']);
    });

    it('adds draft, conflicts and check counts', () => {
      expect(pills({ isDraft: true, mergeable: 'CONFLICTING', checks: { passed: 5, failed: 2, pending: 1, failing: ['lint', 'build'] } })).toEqual([
        'No review required',
        'Draft',
        'Merge conflicts',
        '2 failing',
        '1 pending',
        '5 passed',
      ]);
    });

    it('does not mention checks or conflicts that are not there', () => {
      expect(pills({ mergeable: 'UNKNOWN' })).toEqual(['No review required']);
    });
  });

  it('lists labels, only when there are some', () => {
    expect(text(mount(renderDetails(makePrDetails({ labels: ['bug', 'urgent'] }))), '.labels .label')).toEqual(['bug', 'urgent']);
    expect(mount(renderDetails(makePrDetails())).querySelector('.labels')).toBeNull();
  });

  it('renders the description as markdown, unless it is blank', () => {
    expect(mount(renderDetails(makePrDetails({ body: 'Fixes **it**' }))).querySelector('.md strong')?.textContent).toBe('it');
    expect(mount(renderDetails(makePrDetails({ body: '  \n ' }))).querySelector('.md')).toBeNull();
  });

  it('names the failing checks', () => {
    expect(
      mount(renderDetails(makePrDetails({ checks: { passed: 0, failed: 2, pending: 0, failing: ['lint', 'build'] } }))).querySelector('.failing')?.textContent,
    ).toBe('Failing: lint, build');
    expect(mount(renderDetails(makePrDetails())).querySelector('.failing')).toBeNull();
  });

  describe('people', () => {
    it('shows each reviewer with what they did, and the time on hover', () => {
      const host = mount(
        renderDetails(
          makePrDetails({
            reviews: [
              { login: 'alice', state: 'APPROVED', at: '2026-03-01T10:00:00.000Z' },
              { login: 'bob', state: 'CHANGES_REQUESTED', at: null },
              { login: 'cy', state: 'COMMENTED', at: null },
              { login: 'di', state: 'PENDING', at: null },
              { login: 'ed', state: 'DISMISSED', at: null },
              { login: 'flo', state: 'SOMETHING_NEW', at: null },
            ],
          }),
        ),
      );
      expect(text(host, '.people-col:first-child .login')).toEqual(['alice', 'bob', 'cy', 'di', 'ed', 'flo']);
      expect(text(host, '.people-col:first-child .state')).toEqual([
        'approved',
        'requested changes',
        'commented',
        'review in progress',
        'dismissed',
        'something_new',
      ]);
      expect([...host.querySelectorAll('.state')].map((node) => node.className.replace('state', '').trim())).toEqual(['good', 'bad', '', 'wait', '', '']);
      expect(text(host, '.avatar')).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
      expect((host.querySelector('.person') as HTMLElement).title).not.toBe('');
      expect((host.querySelectorAll('.person')[1] as HTMLElement).title).toBe('');
    });

    it('says when nobody has reviewed', () => {
      expect(text(mount(renderDetails(makePrDetails())), '.people-col .empty')).toEqual(['None yet']);
    });

    it('lists who is still being waited on, only when someone is', () => {
      const host = mount(renderDetails(makePrDetails({ requested: ['alice', 'team/core'] })));
      expect(text(host, '.people-col:nth-child(2) h3')).toEqual(['Waiting on 2']);
      expect(text(host, '.people-col:nth-child(2) .login')).toEqual(['alice', 'team/core']);
      expect(mount(renderDetails(makePrDetails())).querySelectorAll('.people-col')).toHaveLength(1);
    });
  });

  describe('files and commits', () => {
    it('folds the changed files under a count, with the name first and the folder beside it', () => {
      const host = mount(
        renderDetails(
          makePrDetails({
            changedFiles: 2,
            files: [
              { path: 'src/deep/file.ts', additions: 4, deletions: 1 },
              { path: 'README.md', additions: 1, deletions: 0 },
            ],
          }),
        ),
      );
      const files = host.querySelectorAll('details.glance')[0]!;
      expect(files.querySelector('summary')?.textContent).toBe('2 files changed');
      expect(text(files, '.glance-name')).toEqual(['file.ts', 'README.md']);
      expect(text(files, '.glance-dir')).toEqual(['src/deep', '']);
      expect(text(files, '.add')).toEqual(['+4', '+1']);
      expect(text(files, '.del')).toEqual(['−1', '−0']);
      expect((files.querySelector('.glance-row') as HTMLElement).title).toBe('src/deep/file.ts');
      expect(files.querySelector('.glance-more')).toBeNull();
    });

    it('says how many more files there are than are listed, and uses the singular for one', () => {
      const files = Array.from({ length: 10 }, (_, index) => ({ path: `f${index}.ts`, additions: 1, deletions: 0 }));
      expect(text(mount(renderDetails(makePrDetails({ changedFiles: 25, files }))), '.glance-more')).toEqual(['…and 15 more']);
      expect(mount(renderDetails(makePrDetails({ changedFiles: 1, files: files.slice(0, 1) }))).querySelector('summary')?.textContent).toBe('1 file changed');
    });

    it('folds the commits under a count, newest first, with author and age', () => {
      const host = mount(
        renderDetails(
          makePrDetails({
            commitCount: 12,
            commits: [
              { sha: 'abc1234', headline: 'Fix it', author: 'alice', date: ago(2 * HOUR) },
              { sha: 'def5678', headline: 'Start it', author: 'bob', date: ago(3 * 24 * HOUR) },
            ],
          }),
        ),
      );
      const commits = host.querySelector('details.glance')!;
      expect(commits.querySelector('summary')?.textContent).toBe('12 commits');
      expect(text(commits, '.glance-name')).toEqual(['Fix it', 'Start it']);
      expect(text(commits, '.glance-dir')).toEqual(['alice · 2h ago', 'bob · 3d ago']);
      expect((commits.querySelector('.glance-row') as HTMLElement).title).toBe('abc1234 · alice');
      expect(text(commits, '.glance-more')).toEqual(['…and 10 more']);
    });

    it('shows neither when there are no files or commits', () => {
      expect(mount(renderDetails(makePrDetails())).querySelector('details')).toBeNull();
    });
  });
});

describe('renderThreads', () => {
  const thread = (overrides: Partial<PrThread> = {}): PrThread => ({
    path: 'src/a.ts',
    line: 7,
    resolved: false,
    outdated: false,
    comments: [{ author: 'alice', body: 'Why **this**?', at: ago(2 * HOUR), url: 'https://github.com/acme/app/pull/12#discussion_r1' }],
    ...overrides,
  });

  it('says so when there are none', () => {
    expect(text(mount(renderThreads([], 0)), '.threads-empty')).toEqual(['No review comments.']);
  });

  it('shows open threads with their location, author, age and markdown body', () => {
    const host = mount(renderThreads([thread()], 1));
    expect(host.querySelector('details.glance')?.hasAttribute('open')).toBe(false);
    expect(host.querySelector('summary')?.childNodes[1]?.textContent).toBe('Review comments');
    expect(text(host, 'summary .thread-count')).toEqual(['1 open']);
    expect(text(host, '.thread-where')).toEqual(['src/a.ts:7']);
    expect(text(host, '.thread-head .author')).toEqual(['alice']);
    expect(text(host, '.thread-when')).toEqual(['2h ago']);
    expect(host.querySelector('.thread-comment .md strong')?.textContent).toBe('this');
  });

  it('shows a comment on a whole file without a line, and every comment in a thread', () => {
    const host = mount(
      renderThreads(
        [
          thread({
            line: null,
            comments: [
              { author: 'alice', body: 'one', at: ago(HOUR), url: 'u1' },
              { author: 'bob', body: 'two', at: '', url: 'u2' },
            ],
          }),
        ],
        1,
      ),
    );
    expect(text(host, '.thread-where')).toEqual(['src/a.ts']);
    expect(text(host, '.thread-head .author')).toEqual(['alice', 'bob']);
    expect(text(host, '.thread-when')).toEqual(['1h ago', '']);
  });

  it('flags outdated threads', () => {
    expect(text(mount(renderThreads([thread({ outdated: true })], 1)), '.thread-flag')).toEqual(['outdated']);
    expect(mount(renderThreads([thread()], 1)).querySelector('.thread-flag')).toBeNull();
  });

  it('folds resolved threads under their count, after the open ones', () => {
    const host = mount(renderThreads([thread({ resolved: true, path: 'b.ts' }), thread({ path: 'a.ts' }), thread({ resolved: true, path: 'c.ts' })], 3));
    expect(text(host, 'summary .thread-count')).toEqual(['1 open', '2 resolved']);
    const folded = host.querySelector('details.glance details.glance')!;
    expect(folded.querySelector('summary')?.textContent).toBe('2 resolved threads');
    expect(text(folded, '.thread-where')).toEqual(['b.ts:7', 'c.ts:7']);
    expect(folded.querySelectorAll('.thread.resolved')).toHaveLength(2);
    expect(text(host, ':scope > details > .glance-body > .thread .thread-where')).toEqual(['a.ts:7']);
  });

  it('says all resolved when nothing is open, using the singular for one', () => {
    const host = mount(renderThreads([thread({ resolved: true })], 1));
    expect(text(host, 'summary .thread-count')).toEqual(['all resolved', '1 resolved']);
    expect(host.querySelector('details details summary')?.textContent).toBe('1 resolved thread');
  });

  it('says how many were left out when there are more than are shown', () => {
    expect(text(mount(renderThreads([thread()], 9)), '.threads-empty')).toEqual(['Showing 1 of 9 threads.']);
    expect(mount(renderThreads([thread()], 1)).querySelector('.threads-empty')).toBeNull();
  });

  it("opens a thread's first comment on GitHub when its location is clicked", () => {
    const fake = installChrome();
    const host = mount(renderThreads([thread()], 1));
    (host.querySelector('.thread-where') as HTMLButtonElement).click();
    expect(fake.mock.tabs.create).toHaveBeenCalledWith({ url: 'https://github.com/acme/app/pull/12#discussion_r1' });
  });

  it('does nothing when a thread has no comments to open', () => {
    const fake = installChrome();
    (mount(renderThreads([thread({ comments: [] })], 1)).querySelector('.thread-where') as HTMLButtonElement).click();
    expect(fake.mock.tabs.create).not.toHaveBeenCalled();
  });
});
