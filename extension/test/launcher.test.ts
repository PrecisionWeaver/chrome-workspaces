// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewRequest, ReviewsState, Workspace } from '../../shared/protocol';
import { createLauncher, type Launcher } from '../src/launcher';
import { installChrome } from './chrome-mock';
import { isolateDocumentListeners, loadPanelHtml, makeReview, makeWorkspace } from './fixtures';

isolateDocumentListeners();

let fake: ReturnType<typeof installChrome>;
let launcher: Launcher;
const options = {
  send: vi.fn(() => true),
  create: vi.fn(),
  closeCreate: vi.fn(),
  selectedUrl: vi.fn((): string | null => null),
  openWorkspace: vi.fn(),
};

const state = (items: ReviewRequest[], overrides: Partial<ReviewsState> = {}): ReviewsState => ({
  items,
  error: null,
  fetchedAt: null,
  refreshing: false,
  ...overrides,
});
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Creates the launcher against the real markup and lets its saved settings load. */
async function start(saved: Record<string, unknown> = {}) {
  Object.assign(fake.storage.local, saved);
  launcher = createLauncher(options);
  await flush();
}
const rows = () => [...document.querySelectorAll<HTMLElement>('#reviews-list > li.review')];
const refs = () => rows().map((row) => row.querySelector('code')?.textContent);
const facetButton = (facet: string) => document.querySelector<HTMLButtonElement>(`.facet[data-facet="${facet}"]`)!;
const search = (text: string) => {
  const input = $<HTMLInputElement>('reviews-search');
  input.value = text;
  input.dispatchEvent(new Event('input'));
};

beforeEach(() => {
  fake = installChrome();
  loadPanelHtml();
  Object.values(options).forEach((fn) => fn.mockClear());
  options.selectedUrl.mockReturnValue(null);
});
afterEach(() => vi.unstubAllGlobals());

describe('the list', () => {
  const a = makeReview({ number: 1, title: 'First change', url: 'u1' });
  const b = makeReview({ number: 2, title: 'Second change', url: 'u2', author: 'hubot', repo: 'acme/api' });

  it('titles the section with the count and lists each request with its ref, title and author', async () => {
    await start();
    launcher.renderReviews(state([a, b]), []);
    expect($('reviews-title').textContent).toBe('Review requests (2)');
    expect(refs()).toEqual(['app#1', 'api#2']);
    expect(rows().map((row) => row.querySelector('.title')?.textContent)).toEqual(['First change', 'Second change']);
    expect(rows()[1]!.querySelector('.author')?.textContent).toBe('hubot');
    expect(rows()[0]!.title).toBe('First change\nacme/app by octocat');
  });

  it('shows a merge badge for each state but unknown, with an explanation', async () => {
    await start();
    launcher.renderReviews(
      state([
        makeReview({ number: 1, merge: 'ready' }),
        makeReview({ number: 2, merge: 'review' }),
        makeReview({ number: 3, merge: 'draft' }),
        makeReview({ number: 4, merge: 'blocked', mergeReason: 'Conflicts' }),
        makeReview({ number: 5, merge: 'blocked' }),
        makeReview({ number: 6, merge: 'unknown' }),
      ]),
      [],
    );
    const badges = rows().map((row) => row.querySelector<HTMLElement>('.merge'));
    expect(badges.map((badge) => badge?.textContent ?? null)).toEqual(['Can merge', 'Ready for review', 'Draft', 'Conflicts', "Can't merge", null]);
    expect(badges[0]!.title).toBe('Approved, checks passing, no conflicts');
    expect(badges[3]!.title).toBe('Cannot merge yet: Conflicts');
    expect(badges[4]!.title).toBe('Cannot merge yet: blocked');
    expect(badges[0]!.className).toBe('merge ready');
  });

  it('flags a PR that has new commits since your review, and shows its checks', async () => {
    await start();
    launcher.renderReviews(
      state([
        makeReview({ number: 1, needsReReview: true, ci: 'failing' }),
        makeReview({ number: 2, ci: 'passing' }),
        makeReview({ number: 3, ci: 'pending' }),
        makeReview({ number: 4 }),
      ]),
      [],
    );
    expect(rows().map((row) => row.querySelector('.rereview')?.textContent ?? null)).toEqual(['New commits', null, null, null]);
    expect(rows().map((row) => row.querySelector<HTMLElement>('.ci')?.className ?? null)).toEqual(['ci failing', 'ci passing', 'ci pending', null]);
    expect(rows().map((row) => row.querySelector('.ci')?.textContent ?? null)).toEqual(['Checks failing', 'Checks passing', 'Checks running', null]);
  });

  it('leaves out a checks tag that Can merge, or a Checks failing reason, already says', async () => {
    await start();
    launcher.renderReviews(
      state([
        makeReview({ number: 1, merge: 'ready', ci: 'passing' }),
        makeReview({ number: 2, merge: 'blocked', mergeReason: 'Checks failing', ci: 'failing' }),
        makeReview({ number: 3, merge: 'blocked', mergeReason: 'Conflicts', ci: 'failing' }),
        makeReview({ number: 4, merge: 'review', ci: 'passing' }),
      ]),
      [],
    );
    expect(rows().map((row) => row.querySelector('.ci')?.textContent ?? null)).toEqual([null, null, 'Checks failing', 'Checks passing']);
  });

  it('shows the checks as a tag, so the workspace dot is the row’s only dot', async () => {
    await start();
    launcher.renderReviews(state([makeReview({ url: 'u1', ci: 'passing' })]), [makeWorkspace({ pr: 'u1' })]);
    expect(rows()[0]!.querySelectorAll('.has-workspace')).toHaveLength(1);
    expect(rows()[0]!.querySelector('.ci')?.textContent).toBe('Checks passing');
  });

  it('marks requests that already have a workspace, and names it', async () => {
    await start();
    launcher.renderReviews(state([a, b]), [makeWorkspace({ name: 'acme/app #1', pr: 'u1' })]);
    expect(rows().map((row) => row.querySelector('.has-workspace') !== null)).toEqual([true, false]);
    expect(rows()[0]!.title).toContain('\nWorkspace: acme/app #1');
  });

  it('marks the request the new-workspace view is open for', async () => {
    options.selectedUrl.mockReturnValue('u2');
    await start();
    launcher.renderReviews(state([a, b]), []);
    expect(rows().map((row) => row.classList.contains('selected'))).toEqual([false, true]);
  });

  it('shows the first line of an error, with the whole of it on hover, and keeps the old list', async () => {
    await start();
    launcher.renderReviews(state([a], { error: 'gh: not logged in\nrun gh auth login' }), []);
    expect($('reviews-error').hidden).toBe(false);
    expect($('reviews-error').textContent).toBe('gh: not logged in');
    expect($('reviews-error').title).toBe('gh: not logged in\nrun gh auth login');
    expect(refs()).toEqual(['app#1']);
    launcher.renderReviews(state([a]), []);
    expect($('reviews-error').hidden).toBe(true);
  });
});

describe('clicking a request', () => {
  const review = makeReview({ url: 'u1' });

  it('opens the new-workspace view for it', async () => {
    await start();
    launcher.renderReviews(state([review]), []);
    rows()[0]!.click();
    expect(options.create).toHaveBeenCalledWith(review);
  });

  it('opens the existing workspace when there is one, rather than making a second', async () => {
    const existing: Workspace = makeWorkspace({ pr: 'u1' });
    await start();
    launcher.renderReviews(state([review]), [existing]);
    rows()[0]!.click();
    expect(options.openWorkspace).toHaveBeenCalledWith(existing);
    expect(options.create).not.toHaveBeenCalled();
  });

  it('closes the new-workspace view when it is the one already open for it', async () => {
    options.selectedUrl.mockReturnValue('u1');
    await start();
    launcher.renderReviews(state([review]), [makeWorkspace({ pr: 'u1' })]);
    rows()[0]!.click();
    expect(options.closeCreate).toHaveBeenCalled();
    expect(options.create).not.toHaveBeenCalled();
    expect(options.openWorkspace).not.toHaveBeenCalled();
  });
});

describe('refreshing', () => {
  it('asks the helper to refresh, and disables the button while it does', async () => {
    await start();
    $('reviews-refresh').click();
    expect(options.send).toHaveBeenCalledWith({ type: 'refreshReviews' });
    launcher.renderReviews(state([], { refreshing: true }), []);
    expect($<HTMLButtonElement>('reviews-refresh').disabled).toBe(true);
    launcher.renderReviews(state([], { refreshing: false, fetchedAt: new Date(Date.now() - 5 * 60_000).toISOString() }), []);
    expect($<HTMLButtonElement>('reviews-refresh').disabled).toBe(false);
    expect($('reviews-refresh').title).toBe('Refresh review requests (updated 5m ago)');
  });

  it('has a plain title until something has been fetched', async () => {
    await start();
    launcher.renderReviews(state([]), []);
    expect($('reviews-refresh').title).toBe('Refresh review requests');
  });
});

describe('searching', () => {
  const items = [
    makeReview({ number: 1, title: 'Fix login bug', url: 'u1', author: 'alice', ticket: 'PROJ-123' }),
    makeReview({ number: 2, title: 'Add logging', url: 'u2', author: 'bob', repo: 'acme/api' }),
    makeReview({ number: 3, title: 'Refactor', url: 'u3', author: 'alice', isDraft: true, merge: 'draft' }),
  ];

  it('needs every word to match somewhere: title, author, repo, ticket or number', async () => {
    await start();
    launcher.renderReviews(state(items), []);
    search('log');
    expect(refs()).toEqual(['app#1', 'api#2']);
    search('log alice');
    expect(refs()).toEqual(['app#1']);
    search('proj-123');
    expect(refs()).toEqual(['app#1']);
    search('api#2');
    expect(refs()).toEqual(['api#2']);
    search('acme/api');
    expect(refs()).toEqual(['api#2']);
  });

  it('finds drafts by the word draft', async () => {
    await start();
    launcher.renderReviews(state(items), []);
    search('DRAFT');
    expect(refs()).toEqual(['app#3']);
  });

  it('shows how many matched out of how many, and everything again when cleared', async () => {
    await start();
    launcher.renderReviews(state(items), []);
    search('bob');
    expect($('reviews-title').textContent).toBe('Review requests (1 of 3)');
    search('');
    expect($('reviews-title').textContent).toBe('Review requests (3)');
  });

  it('clears on Escape without that reaching the rest of the panel', async () => {
    await start();
    launcher.renderReviews(state(items), []);
    search('bob');
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    const reached = vi.fn();
    document.addEventListener('keydown', reached, { once: true });
    $('reviews-search').dispatchEvent(escape);
    expect($<HTMLInputElement>('reviews-search').value).toBe('');
    expect(refs()).toHaveLength(3);
    expect(reached).not.toHaveBeenCalled();
    document.removeEventListener('keydown', reached);
  });

  it('keeps the search when the list is re-rendered with new data', async () => {
    await start();
    launcher.renderReviews(state(items), []);
    search('bob');
    launcher.renderReviews(state(items), []);
    expect(refs()).toEqual(['api#2']);
  });
});

describe('filtering by author, repo and status', () => {
  const items = [
    makeReview({ number: 1, url: 'u1', author: 'alice', repo: 'acme/app', merge: 'ready' }),
    makeReview({ number: 2, url: 'u2', author: 'bob', repo: 'acme/api', merge: 'review' }),
    makeReview({ number: 3, url: 'u3', author: 'alice', repo: 'acme/api', merge: 'draft' }),
  ];
  const options_ = () => [...document.querySelectorAll('#reviews-facet .facet-option')];

  it('opens a checklist with each value and its count, sorted, repos without their owner', async () => {
    await start();
    launcher.renderReviews(state(items), []);
    expect($('reviews-facet').hidden).toBe(true);
    facetButton('repo').click();
    expect($('reviews-facet').hidden).toBe(false);
    expect(facetButton('repo').classList.contains('open')).toBe(true);
    expect(options_().map((row) => [row.querySelector('.facet-name')?.textContent, row.querySelector('.facet-count')?.textContent])).toEqual([
      ['api', '2'],
      ['app', '1'],
    ]);
    expect((options_()[0]!.querySelector('.facet-name') as HTMLElement).title).toBe('acme/api');
  });

  it('hides a request when its value is unticked, and says so on the button', async () => {
    await start();
    launcher.renderReviews(state(items), []);
    facetButton('author').click();
    const alice = options_()[0]!.querySelector('input') as HTMLInputElement;
    alice.checked = false;
    alice.dispatchEvent(new Event('change'));
    expect(refs()).toEqual(['api#2']);
    expect(facetButton('author').textContent).toBe('Authors 1/2');
    expect(facetButton('author').classList.contains('active')).toBe(true);
    expect($('reviews-title').textContent).toBe('Review requests (1 of 3)');
  });

  it('filters on status by its label', async () => {
    await start();
    launcher.renderReviews(state(items), []);
    facetButton('status').click();
    expect(options_().map((row) => row.querySelector('.facet-name')?.textContent)).toEqual(['Can merge', 'Draft', 'Ready for review']);
    const draft = options_()[1]!.querySelector('input') as HTMLInputElement;
    draft.checked = false;
    draft.dispatchEvent(new Event('change'));
    expect(refs()).toEqual(['app#1', 'api#2']);
  });

  it('has All and None to tick or untick every value at once', async () => {
    await start();
    launcher.renderReviews(state(items), []);
    facetButton('author').click();
    const [all, none] = [...document.querySelectorAll<HTMLButtonElement>('.facet-bulk button')] as [HTMLButtonElement, HTMLButtonElement];
    none.click();
    expect(refs()).toEqual([]);
    expect(facetButton('author').textContent).toBe('Authors 0/2');
    all.click();
    expect(refs()).toHaveLength(3);
    expect(facetButton('author').textContent).toBe('Authors');
  });

  it('closes the checklist when its button is clicked again, or on Escape', async () => {
    await start();
    launcher.renderReviews(state(items), []);
    facetButton('author').click();
    facetButton('author').click();
    expect($('reviews-facet').hidden).toBe(true);

    facetButton('author').click();
    facetButton('repo').click();
    expect(facetButton('author').classList.contains('open')).toBe(false);
    expect(facetButton('repo').classList.contains('open')).toBe(true);

    const reached = vi.fn();
    document.addEventListener('keydown', reached);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect($('reviews-facet').hidden).toBe(true);
    // Closing the list is not also a close of the new-workspace view behind it.
    expect(reached).not.toHaveBeenCalled();
    document.removeEventListener('keydown', reached);
  });

  it('leaves Escape alone when no checklist is open', async () => {
    await start();
    const reached = vi.fn();
    document.addEventListener('keydown', reached);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(reached).toHaveBeenCalled();
    document.removeEventListener('keydown', reached);
  });

  it('remembers what was hidden, so a new author or repo still shows up', async () => {
    await start();
    launcher.renderReviews(state(items), []);
    facetButton('author').click();
    (document.querySelector('.facet-bulk button:nth-child(2)') as HTMLButtonElement).click();
    expect(fake.storage.local.reviewsHidden).toEqual({ author: ['alice', 'bob'], repo: [], status: [] });

    document.body.innerHTML = '';
    loadPanelHtml();
    await start(fake.storage.local);
    launcher.renderReviews(state([...items, makeReview({ number: 9, url: 'u9', author: 'carol' })]), []);
    expect(refs()).toEqual(['app#9']);
  });
});

describe('collapsing', () => {
  it('collapses and expands the section, and remembers which', async () => {
    await start();
    $('reviews-toggle').click();
    expect($('reviews').classList.contains('collapsed')).toBe(true);
    expect(fake.storage.local.reviewsCollapsed).toBe(true);
    $('reviews-toggle').click();
    expect(fake.storage.local.reviewsCollapsed).toBe(false);
  });

  it('starts collapsed when it was left that way', async () => {
    await start({ reviewsCollapsed: true });
    expect($('reviews').classList.contains('collapsed')).toBe(true);
  });
});
