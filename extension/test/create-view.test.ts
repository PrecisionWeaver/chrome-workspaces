// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlToHelper, Workspace } from '../../shared/protocol';
import { createCreateView, type CreateView } from '../src/create-view';
import { noteReviewTab } from '../src/tabs';
import { installChrome } from './chrome-mock';
import { isolateDocumentListeners, loadPanelHtml, makePrDetails, makeReview, makeWorkspace } from './fixtures';

isolateDocumentListeners();

const PR = 'https://github.com/acme/app/pull/12';

let fake: ReturnType<typeof installChrome>;
let view: CreateView;
let sent: ControlToHelper[];
let toggled: number;
let here: { windowId: number | undefined; workspace: Workspace | undefined };
let ticketLink: (ticket: string | null) => string | null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const sentOfType = <T extends ControlToHelper['type']>(type: T) =>
  sent.filter((message): message is Extract<ControlToHelper, { type: T }> => message.type === type);
const created = () => sentOfType('create')[0]!;

beforeEach(() => {
  fake = installChrome();
  loadPanelHtml();
  sent = [];
  toggled = 0;
  here = { windowId: undefined, workspace: undefined };
  ticketLink = (ticket) => (ticket ? `https://jira.example.com/browse/${ticket}` : null);
  view = createCreateView({
    send: (message) => (sent.push(message), true),
    onToggle: () => void toggled++,
    here: () => here,
    ticketLink: (ticket) => ticketLink(ticket),
  });
});
afterEach(() => vi.unstubAllGlobals());

/** Opens the view and lets its saved settings load. */
async function open(review?: Parameters<CreateView['show']>[0]) {
  view.show(review);
  await flush();
}
const click = (selector: string) => (document.querySelector(selector) as HTMLElement).click();
const choose = (value: string) => click(`#create-start button[data-value="${value}"]`);
const submit = () => $('create-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
const type = (id: string, value: string) => (($(id) as HTMLInputElement).value = value);

describe('opening and closing', () => {
  it('opens blank, titled New workspace, and tells the panel', async () => {
    await open();
    expect(view.isOpen).toBe(true);
    expect($('create').hidden).toBe(false);
    expect($('create-title').textContent).toBe('New workspace');
    expect($<HTMLInputElement>('create-name').value).toBe('');
    expect(document.activeElement).toBe($('create-name'));
    expect(toggled).toBe(1);
    expect(view.review).toBeNull();
    expect($('create-details').hidden).toBe(true);
    expect($('create-github').hidden).toBe(true);
  });

  it('asks the helper for prompts and repos each time it opens', async () => {
    await open();
    expect(sent).toEqual([{ type: 'listPrompts' }, { type: 'listRepos' }]);
  });

  it('closes from the X button or Escape, but only when open, and tells the panel once', async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(toggled).toBe(0);

    await open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(view.isOpen).toBe(false);
    expect($('create').hidden).toBe(true);
    expect(toggled).toBe(2);

    await open();
    click('#create-close');
    expect(view.isOpen).toBe(false);
    view.close();
    expect(toggled).toBe(4);
  });

  it('starts from the top and with nothing left from last time', async () => {
    await open();
    type('create-name', 'old');
    type('create-filter', 'old');
    $('create').scrollTop = 99;
    await open();
    expect($<HTMLInputElement>('create-name').value).toBe('');
    expect($<HTMLInputElement>('create-filter').value).toBe('');
    expect($('create').scrollTop).toBe(0);
  });
});

describe('for a review request', () => {
  const review = makeReview({ url: PR, ticket: 'PROJ-123', title: 'Add the thing' });

  it('is named for the PR, titled with its chip, and starts at its prompts with the filter focused', async () => {
    await open(review);
    expect(view.review).toBe(review);
    expect($<HTMLInputElement>('create-name').value).toBe('app#12');
    expect($('create-title').querySelector('.ref-chip')?.textContent).toBe('app#12');
    expect($('create-title').textContent).toContain('Add the thing');
    expect($('create-prompt').hidden).toBe(false);
    expect(document.activeElement).toBe($('create-filter'));
    expect($<HTMLTextAreaElement>('create-tabs').value).toBe(PR);
    expect($('create-templates').hidden).toBe(true);
  });

  it('asks for the details and comments, and shows loading until they arrive', async () => {
    await open(review);
    expect(sent).toContainEqual({ type: 'prDetails', url: PR });
    expect(sent).toContainEqual({ type: 'prThreads', url: PR });
    expect($('create-details').textContent).toBe('Loading PR details…');
    expect($('create-threads').textContent).toBe('Loading review comments…');
    expect($('create-details').hidden).toBe(false);
    expect($('create-github').hidden).toBe(false);
  });

  it('offers the ticket in Jira when a site is configured, and not otherwise', async () => {
    await open(review);
    expect($('create-ticket').hidden).toBe(false);
    expect($('create-ticket').textContent).toContain('PROJ-123 in Jira');
    click('#create-ticket');
    expect(fake.mock.tabs.create).toHaveBeenCalledWith({ url: 'https://jira.example.com/browse/PROJ-123' });

    ticketLink = () => null;
    await open(review);
    expect($('create-ticket').hidden).toBe(true);
    fake.mock.tabs.create.mockClear();
    click('#create-ticket');
    expect(fake.mock.tabs.create).not.toHaveBeenCalled();
  });

  it('starts in the repo the PR belongs to when that repo is listed, else the default directory', async () => {
    await open(review);
    view.setRepos([
      { name: 'web', path: '/Users/me/web', root: '/Users/me' },
      { name: 'app', path: '/Users/me/app', root: '/Users/me' },
    ]);
    expect($<HTMLSelectElement>('create-repo').value).toBe('/Users/me/app');

    await open(makeReview({ repo: 'acme/other', url: 'u2' }));
    expect($<HTMLSelectElement>('create-repo').value).toBe('');
  });

  it('starts from the last repo but never the tabs of an earlier workspace', async () => {
    fake.storage.local.newRepo = '/Users/me/web';
    fake.storage.local.newTabs = 'https://example.com/';
    await open();
    view.setRepos([{ name: 'web', path: '/Users/me/web', root: '/Users/me' }]);
    expect($<HTMLSelectElement>('create-repo').value).toBe('/Users/me/web');
    expect($<HTMLTextAreaElement>('create-tabs').value).toBe('');

    await open(review);
    expect($<HTMLSelectElement>('create-repo').value).toBe('');
    expect($<HTMLTextAreaElement>('create-tabs').value).toBe(review.url);
  });

  describe('details', () => {
    it('shows the details when they arrive, and the comments', async () => {
      await open(review);
      view.setPrDetails(PR, makePrDetails({ head: 'feature/x' }), null);
      expect($('create-details').querySelector('.branches code')?.textContent).toBe('feature/x');
      view.setPrThreads({ type: 'prThreads', url: PR, threads: [], total: 0, error: null });
      expect($('create-threads').textContent).toBe('No review comments.');
    });

    it('ignores details and comments for a different PR', async () => {
      await open(review);
      view.setPrDetails('https://github.com/acme/app/pull/99', makePrDetails(), null);
      view.setPrThreads({ type: 'prThreads', url: 'other', threads: [], total: 0, error: null });
      expect($('create-details').textContent).toBe('Loading PR details…');
      expect($('create-threads').textContent).toBe('Loading review comments…');
    });

    it('says why details could not load', async () => {
      await open(review);
      view.setPrDetails(PR, null, 'gh failed');
      expect($('create-details').textContent).toBe('Could not load PR details: gh failed');
      view.setPrThreads({ type: 'prThreads', url: PR, threads: [], total: 0, error: 'rate limited' });
      expect($('create-threads').textContent).toBe('Could not load review comments: rate limited');
    });

    it('shows earlier details at once when the PR is reopened, and keeps them if the refresh fails', async () => {
      await open(review);
      view.setPrDetails(PR, makePrDetails({ head: 'feature/x' }), null);
      view.close();

      await open(review);
      expect($('create-details').querySelector('.branches code')?.textContent).toBe('feature/x');
      expect($('create-details').classList.contains('refreshing')).toBe(true);

      view.setPrDetails(PR, null, 'offline');
      expect($('create-details').classList.contains('refreshing')).toBe(false);
      expect($('create-details').querySelector('.branches code')?.textContent).toBe('feature/x');
      expect($('create-details').textContent).toContain('Could not refresh PR details: offline');
    });

    it('remembers details that arrive after the view was closed, for next time', async () => {
      await open(review);
      view.close();
      view.setPrDetails(PR, makePrDetails({ head: 'late' }), null);
      await open(review);
      expect($('create-details').querySelector('.branches code')?.textContent).toBe('late');
    });
  });

  it('opens the PR in the workspace when the GitHub button is pressed, noting the tab so a new workspace takes it', async () => {
    const { windowId } = fake.addWindow();
    here = { windowId, workspace: makeWorkspace({ windowId, groupId: null }) };
    await open(review);
    click('#create-github');
    await flush();
    expect(fake.urls(windowId)).toContain(PR);
    expect(fake.storage.session.reviewTab).toMatchObject({ url: PR });
  });

  it('does not note the tab when the PR was already open', async () => {
    const { windowId } = fake.addWindow();
    fake.addTab(windowId, PR);
    here = { windowId, workspace: makeWorkspace({ windowId }) };
    await open(review);
    click('#create-github');
    await flush();
    expect(fake.storage.session.reviewTab).toBeUndefined();
    void noteReviewTab;
  });
});

describe('prompts', () => {
  const prompts = [
    { section: 'Review', text: '/review PR-URL' },
    { section: 'Review', text: 'Summarise PR-URL for PROJ-XXX' },
    { section: 'Plan', text: 'Plan the work' },
    { section: '', text: 'Anything' },
  ];
  const cards = () => [...document.querySelectorAll<HTMLElement>('#create-prompts .prompt')];

  it('groups them by section with counts, splitting a leading command from the text', async () => {
    await open();
    view.setPrompts(prompts, null);
    expect([...document.querySelectorAll('#create-prompts h3')].map((h) => h.firstChild?.textContent)).toEqual(['Review', 'Plan', 'Prompts']);
    expect([...document.querySelectorAll('#create-prompts h3 .count')].map((count) => count.textContent)).toEqual(['2', '1', '1']);
    expect(cards()[0]!.querySelector('code')?.textContent).toBe('/review');
    expect(cards()[0]!.title).toBe('/review PR-URL');
  });

  it('filters on section and text', async () => {
    await open();
    view.setPrompts(prompts, null);
    type('create-filter', 'plan');
    $('create-filter').dispatchEvent(new Event('input'));
    expect(cards().map((card) => card.title)).toEqual(['Plan the work']);
    type('create-filter', 'nothing like it');
    $('create-filter').dispatchEvent(new Event('input'));
    expect(cards()).toEqual([]);
  });

  it('shows an error from reading them, and clears it', async () => {
    await open();
    view.setPrompts([], 'no prompts file');
    expect($('create-error').hidden).toBe(false);
    expect($('create-error').textContent).toBe('Could not read prompts: no prompts file');
    view.setPrompts(prompts, null);
    expect($('create-error').hidden).toBe(true);
  });

  it('fills PR-URL and the ticket from the review when one is picked, and lets it be changed', async () => {
    await open(makeReview({ url: PR, ticket: 'PROJ-123' }));
    view.setPrompts(prompts, null);
    cards()[1]!.click();
    expect($('create-chosen').hidden).toBe(false);
    expect($('create-choose').hidden).toBe(true);
    expect($<HTMLTextAreaElement>('create-text').value).toBe(`Summarise ${PR} for PROJ-123`);
    expect(document.activeElement).toBe($('create-text'));

    click('#create-change');
    expect($('create-choose').hidden).toBe(false);
    expect($('create-chosen').hidden).toBe(true);
  });

  it('leaves the placeholders in a prompt when there is no review to fill them from', async () => {
    await open();
    choose('prompt');
    view.setPrompts(prompts, null);
    cards()[1]!.click();
    expect($<HTMLTextAreaElement>('create-text').value).toBe('Summarise PR-URL for PROJ-XXX');
  });
});

describe('the first message', () => {
  it('shows the prompt picker, the message box or nothing, as chosen', async () => {
    await open();
    expect([$('create-prompt').hidden, $('create-message').hidden]).toEqual([true, true]);
    choose('prompt');
    expect([$('create-prompt').hidden, $('create-message').hidden]).toEqual([false, true]);
    expect(document.activeElement).toBe($('create-filter'));
    choose('text');
    expect([$('create-prompt').hidden, $('create-message').hidden]).toEqual([true, false]);
    expect(document.activeElement).toBe($('create-message-text'));
    choose('blank');
    expect([$('create-prompt').hidden, $('create-message').hidden]).toEqual([true, true]);
  });
});

describe('model, colour and window controls', () => {
  it('offers Default and each model alias, and restores the last pick', async () => {
    fake.storage.local.newModel = 'sonnet';
    await open();
    expect([...$<HTMLSelectElement>('create-model').options].map((option) => option.textContent)).toEqual(['Default', 'opus', 'sonnet', 'haiku']);
    expect($<HTMLSelectElement>('create-model').value).toBe('sonnet');
  });

  it('ignores a saved model that is no longer offered', async () => {
    fake.storage.local.newModel = 'retired';
    await open();
    expect($<HTMLSelectElement>('create-model').value).toBe('');
  });

  it('has a swatch for each colour and one for none, picking one at a time, cleared on each open', async () => {
    await open();
    const swatches = [...document.querySelectorAll<HTMLButtonElement>('#create-color .swatch')];
    expect(swatches).toHaveLength(10);
    expect(swatches[0]!.title).toBe('No color');
    expect(swatches[0]!.classList.contains('selected')).toBe(true);
    swatches[2]!.click();
    expect(swatches.map((swatch) => swatch.classList.contains('selected'))).toEqual([false, false, true, false, false, false, false, false, false, false]);
    await open();
    expect(swatches[2]!.classList.contains('selected')).toBe(false);
    expect(swatches[0]!.classList.contains('selected')).toBe(true);
  });

  it('can only use this window when the panel is in one, and says it joins as a tab group', async () => {
    await open();
    const thisWindow = document.querySelector<HTMLButtonElement>('#create-window [data-value="here"]')!;
    expect(thisWindow.disabled).toBe(true);

    here = { windowId: 5, workspace: makeWorkspace() };
    await open();
    expect(thisWindow.disabled).toBe(false);
    expect(thisWindow.title).toBe('Joins this window as a tab group');
    here = { windowId: 5, workspace: undefined };
    await open();
    expect(thisWindow.title).toBe('');
  });

  it('starts in this window only if that was chosen last time and it is possible', async () => {
    fake.storage.local.useThisWindow = true;
    await open();
    expect(document.querySelector('#create-window .active')?.getAttribute('data-value')).toBe('new');
    here = { windowId: 5, workspace: undefined };
    await open();
    expect(document.querySelector('#create-window .active')?.getAttribute('data-value')).toBe('here');
  });
});

describe('creating', () => {
  it('sends only what was filled in, and closes', async () => {
    await open();
    type('create-name', '  my workspace  ');
    submit();
    expect(created()).toEqual({ type: 'create', name: 'my workspace', windowId: null });
    expect(view.isOpen).toBe(false);
  });

  it('does nothing without a name', async () => {
    await open();
    type('create-name', '   ');
    submit();
    expect(sentOfType('create')).toEqual([]);
    expect(view.isOpen).toBe(true);
  });

  it('sends the model, colour, directory and tabs chosen', async () => {
    await open();
    view.setRepos([{ name: 'app', path: '/Users/me/app', root: '/Users/me' }]);
    type('create-name', 'w');
    type('create-model', 'haiku');
    type('create-repo', '/Users/me/app');
    type('create-tabs', 'example.com/a\nhttps://example.com/b');
    (document.querySelectorAll('#create-color .swatch')[3] as HTMLElement).click();
    submit();
    expect(created()).toEqual({
      type: 'create',
      name: 'w',
      windowId: null,
      urls: ['https://example.com/a', 'https://example.com/b'],
      model: 'haiku',
      color: 'red',
      cwd: '/Users/me/app',
    });
  });

  it('sends a typed message with the same PR-URL and ticket fill-in', async () => {
    await open(makeReview({ url: PR, ticket: 'PROJ-123' }));
    choose('text');
    type('create-message-text', '  Look at PR-URL for PROJ-XXX  ');
    submit();
    expect(created()).toMatchObject({ prompt: `Look at ${PR} for PROJ-123`, pr: PR, urls: [PR] });
  });

  it('sends the prompt that was picked, as edited', async () => {
    await open();
    choose('prompt');
    view.setPrompts([{ section: 'S', text: 'Do it' }], null);
    (document.querySelector('#create-prompts .prompt') as HTMLElement).click();
    type('create-text', 'Do it, but better');
    type('create-name', 'w');
    submit();
    expect(created()).toMatchObject({ prompt: 'Do it, but better' });
  });

  it('will not create with a prompt or message chosen but empty, and focuses the empty box', async () => {
    await open();
    type('create-name', 'w');
    choose('text');
    submit();
    expect(sentOfType('create')).toEqual([]);
    expect(document.activeElement).toBe($('create-message-text'));
    choose('prompt');
    submit();
    expect(sentOfType('create')).toEqual([]);
    expect(document.activeElement).toBe($('create-filter'));
  });

  it('prefills a review workspace with its PR, and sends what is left in the box', async () => {
    await open(makeReview({ url: PR }));
    choose('blank');
    type('create-tabs', `${PR}\nexample.com/a`);
    submit();
    expect(created()).toMatchObject({ pr: PR, urls: [PR, 'https://example.com/a'] });
  });

  it('opens a review workspace without its PR when it is cleared from the box', async () => {
    await open(makeReview({ url: PR }));
    choose('blank');
    type('create-tabs', 'example.com/a');
    submit();
    expect(created()).toMatchObject({ pr: PR, urls: ['https://example.com/a'] });
  });

  it('starts a new workspace with empty tabs after a review', async () => {
    await open(makeReview({ url: PR }));
    await open();
    expect($<HTMLTextAreaElement>('create-tabs').value).toBe('');
  });

  it('refuses a tab that is not a web address, with the reason', async () => {
    await open();
    type('create-name', 'w');
    type('create-tabs', 'ftp://example.com/x');
    submit();
    expect($<HTMLTextAreaElement>('create-tabs').validationMessage).toBe('Not a web address: ftp://example.com/x');
    expect(sentOfType('create')).toEqual([]);
    expect(view.isOpen).toBe(true);
  });

  it('refuses more than twenty tabs', async () => {
    await open();
    type('create-name', 'w');
    type('create-tabs', Array.from({ length: 21 }, (_, index) => `example.com/${index}`).join('\n'));
    submit();
    expect($<HTMLTextAreaElement>('create-tabs').validationMessage).toBe('At most 20 tabs');
    expect(sentOfType('create')).toEqual([]);
  });

  it('remembers the model, repo and window for next time, but not tabs or a review’s repo', async () => {
    await open();
    view.setRepos([{ name: 'app', path: '/Users/me/app', root: '/Users/me' }]);
    type('create-name', 'w');
    type('create-model', 'opus');
    type('create-repo', '/Users/me/app');
    type('create-tabs', ' example.com/a ');
    submit();
    await flush();
    expect(fake.storage.local).toMatchObject({ newModel: 'opus', newRepo: '/Users/me/app', useThisWindow: false });
    expect(fake.storage.local).not.toHaveProperty('newTabs');

    await open(makeReview({ url: PR }));
    choose('blank');
    type('create-model', 'haiku');
    type('create-repo', '');
    type('create-tabs', 'example.com/z');
    submit();
    await flush();
    expect(fake.storage.local).toMatchObject({ newModel: 'haiku', newRepo: '/Users/me/app' });
  });

  describe('in this window', () => {
    it('adopts a window that holds no workspace, opening the tabs it does not already have', async () => {
      const { windowId } = fake.addWindow('https://example.com/a');
      here = { windowId, workspace: undefined };
      await open();
      click('#create-window [data-value="here"]');
      type('create-name', 'w');
      type('create-tabs', 'example.com/a\nexample.com/b');
      submit();
      await flush();
      expect(created()).toMatchObject({ windowId, urls: ['https://example.com/a', 'https://example.com/b'] });
      expect(created()).not.toHaveProperty('group');
      expect(fake.urls(windowId)).toEqual(['https://example.com/a', 'https://example.com/b']);
    });

    it('asks for a tab group when the window already holds a workspace, and opens no tabs itself', async () => {
      const { windowId } = fake.addWindow();
      here = { windowId, workspace: makeWorkspace({ windowId }) };
      await open();
      click('#create-window [data-value="here"]');
      type('create-name', 'w');
      type('create-tabs', 'example.com/a');
      submit();
      await flush();
      expect(created()).toMatchObject({ windowId, group: true });
      expect(fake.mock.tabs.create).not.toHaveBeenCalled();
    });

    it('opens a new window when this one is not possible', async () => {
      await open();
      click('#create-window [data-value="here"]');
      type('create-name', 'w');
      submit();
      expect(created().windowId).toBeNull();
    });
  });
});

describe('templates', () => {
  const template = { id: 't1', name: 'Web', repo: '/Users/me/web', model: 'sonnet', tabs: 'https://example.com/', message: 'Start here', window: 'here' };

  it('lists the saved templates, with None first, hiding the box for a review', async () => {
    fake.storage.local.templates = [template];
    await open();
    expect([...$<HTMLSelectElement>('create-template').options].map((option) => option.textContent)).toEqual(['None', 'Web']);
    expect($('create-templates').hidden).toBe(false);
    await open(makeReview());
    expect($('create-templates').hidden).toBe(true);
  });

  it('fills the form from a template, leaving the name alone', async () => {
    fake.storage.local.templates = [template];
    here = { windowId: 5, workspace: undefined };
    await open();
    view.setRepos([{ name: 'web', path: '/Users/me/web', root: '/Users/me' }]);
    type('create-name', 'mine');
    type('create-template', 't1');
    $('create-template').dispatchEvent(new Event('change'));
    expect($<HTMLInputElement>('create-name').value).toBe('mine');
    expect($<HTMLSelectElement>('create-repo').value).toBe('/Users/me/web');
    expect($<HTMLSelectElement>('create-model').value).toBe('sonnet');
    expect($<HTMLTextAreaElement>('create-tabs').value).toBe('https://example.com/');
    expect($<HTMLTextAreaElement>('create-message-text').value).toBe('Start here');
    expect(document.querySelector('#create-start .active')?.getAttribute('data-value')).toBe('text');
    expect(document.querySelector('#create-window .active')?.getAttribute('data-value')).toBe('here');
    expect($('template-delete').hidden).toBe(false);
  });

  it('falls back to a new window or the default repo when a template points at something unavailable', async () => {
    fake.storage.local.templates = [{ ...template, repo: '/gone', model: 'retired', message: '' }];
    await open();
    type('create-template', 't1');
    $('create-template').dispatchEvent(new Event('change'));
    expect($<HTMLSelectElement>('create-repo').value).toBe('');
    expect($<HTMLSelectElement>('create-model').value).toBe('');
    expect(document.querySelector('#create-window .active')?.getAttribute('data-value')).toBe('new');
    expect(document.querySelector('#create-start .active')?.getAttribute('data-value')).toBe('blank');
  });

  it('saves the form as a template under a name, and selects it', async () => {
    await open();
    choose('text');
    type('create-message-text', ' hello ');
    type('create-tabs', ' example.com/a ');
    click('#template-save');
    expect($('template-name-row').hidden).toBe(false);
    expect(document.activeElement).toBe($('template-name'));
    type('template-name', ' Mine ');
    click('#template-confirm');
    await flush();

    const [saved] = fake.storage.local.templates as { name: string; message: string; tabs: string; window: string }[];
    expect(saved).toMatchObject({ name: 'Mine', message: 'hello', tabs: 'example.com/a', window: 'new' });
    expect($('template-name-row').hidden).toBe(true);
    expect($<HTMLSelectElement>('create-template').selectedOptions[0]?.textContent).toBe('Mine');
    expect($('template-delete').hidden).toBe(false);
  });

  it('saves a picked prompt as it was edited, and no message for a blank start', async () => {
    await open();
    choose('prompt');
    view.setPrompts([{ section: 'S', text: 'Do it' }], null);
    (document.querySelector('#create-prompts .prompt') as HTMLElement).click();
    type('create-text', 'Edited');
    click('#template-save');
    type('template-name', 'P');
    click('#template-confirm');
    await flush();
    choose('blank');
    click('#template-save');
    type('template-name', 'B');
    click('#template-confirm');
    await flush();
    expect((fake.storage.local.templates as { name: string; message: string }[]).map((t) => [t.name, t.message])).toEqual([
      ['P', 'Edited'],
      ['B', ''],
    ]);
  });

  it('replaces a template of the same name, offering its name when saving over a selected one', async () => {
    fake.storage.local.templates = [template];
    await open();
    type('create-template', 't1');
    $('create-template').dispatchEvent(new Event('change'));
    click('#template-save');
    expect($<HTMLInputElement>('template-name').value).toBe('Web');
    type('template-name', 'web');
    click('#template-confirm');
    await flush();
    const saved = fake.storage.local.templates as { id: string; name: string }[];
    expect(saved).toHaveLength(1);
    expect(saved[0]!.id).toBe('t1');
  });

  it('does not save without a name, and Enter saves while Escape cancels without closing the view', async () => {
    await open();
    click('#template-save');
    type('template-name', '  ');
    click('#template-confirm');
    await flush();
    expect(fake.storage.local.templates).toBeUndefined();

    type('template-name', 'Quick');
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true, bubbles: true });
    $('template-name').dispatchEvent(enter);
    await flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(fake.storage.local.templates).toHaveLength(1);

    click('#template-save');
    $('template-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect($('template-name-row').hidden).toBe(true);
    expect(view.isOpen).toBe(true);
  });

  it('deletes the selected template', async () => {
    fake.storage.local.templates = [template, { ...template, id: 't2', name: 'Other' }];
    await open();
    type('create-template', 't1');
    $('create-template').dispatchEvent(new Event('change'));
    click('#template-delete');
    await flush();
    expect((fake.storage.local.templates as { id: string }[]).map((t) => t.id)).toEqual(['t2']);
    expect($('template-delete').hidden).toBe(true);
    expect([...$<HTMLSelectElement>('create-template').options].map((option) => option.textContent)).toEqual(['None', 'Other']);
  });

  it('ignores stored templates that are malformed', async () => {
    fake.storage.local.templates = [{ id: 'x' }, null, 'junk', template];
    await open();
    expect([...$<HTMLSelectElement>('create-template').options].map((option) => option.textContent)).toEqual(['None', 'Web']);
  });
});

describe('repos', () => {
  it('lists each repo, telling apart ones that share a name by their folder', async () => {
    await open();
    view.setRepos([
      { name: 'app', path: '/Users/me/a/app', root: '/Users/me/a' },
      { name: 'app', path: '/Users/me/b/app', root: '/Users/me/b' },
      { name: 'web', path: '/Users/me/a/web', root: '/Users/me/a' },
    ]);
    expect([...$<HTMLSelectElement>('create-repo').options].map((option) => option.textContent)).toEqual([
      'Default directory',
      'app (/Users/me/a)',
      'app (/Users/me/b)',
      'web',
    ]);
  });

  it('keeps the repo picked while the list refreshes, and applies the saved one once it arrives', async () => {
    fake.storage.local.newRepo = '/Users/me/web';
    await open();
    const repos = [
      { name: 'app', path: '/Users/me/app', root: '/Users/me' },
      { name: 'web', path: '/Users/me/web', root: '/Users/me' },
    ];
    view.setRepos(repos);
    expect($<HTMLSelectElement>('create-repo').value).toBe('/Users/me/web');
    type('create-repo', '/Users/me/app');
    $('create-repo').dispatchEvent(new Event('change'));
    view.setRepos(repos);
    expect($<HTMLSelectElement>('create-repo').value).toBe('/Users/me/app');
  });

  it('keeps a deliberate choice of the default directory when the list arrives', async () => {
    fake.storage.local.newRepo = '/Users/me/web';
    await open();
    type('create-repo', '');
    $('create-repo').dispatchEvent(new Event('change'));
    view.setRepos([{ name: 'web', path: '/Users/me/web', root: '/Users/me' }]);
    expect($<HTMLSelectElement>('create-repo').value).toBe('');
  });
});
