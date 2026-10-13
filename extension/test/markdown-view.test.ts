// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderMarkdown } from '../src/markdown-view';
import { installChrome } from './chrome-mock';

let fake: ReturnType<typeof installChrome>;
beforeEach(() => {
  fake = installChrome();
});
afterEach(() => vi.unstubAllGlobals());

const render = (source: string, foldAfter?: number) => {
  const root = renderMarkdown(source, foldAfter);
  document.body.replaceChildren(root);
  return root;
};

describe('renderMarkdown', () => {
  it('builds elements from the parsed tree, so markup in the text stays text', () => {
    const root = render('Hello <img src=x onerror=alert(1)> **bold** and _em_ and ~~gone~~ and `code`');
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('em')?.textContent).toBe('em');
    expect(root.querySelector('del')?.textContent).toBe('gone');
    expect(root.querySelector('p code')?.textContent).toBe('code');
  });

  it('shows headings smaller than the page, two levels down and no lower than h6', () => {
    const root = render('# One\n\n## Two\n\n###### Six');
    expect([...root.querySelectorAll('h3, h4, h6')].map((h) => [h.tagName, h.textContent])).toEqual([
      ['H3', 'One'],
      ['H4', 'Two'],
      ['H6', 'Six'],
    ]);
  });

  it('renders code blocks, quotes and rules', () => {
    const root = render('```js\nlet a = 1;\n```\n\n> quoted\n\n---');
    expect(root.querySelector('pre code')?.textContent).toContain('let a = 1;');
    expect(root.querySelector('blockquote')?.textContent).toContain('quoted');
    expect(root.querySelector('hr')).not.toBeNull();
  });

  it('renders ordered and unordered lists, tight items without a paragraph wrapper', () => {
    const root = render('- one\n- two\n\n1. first\n2. second');
    expect([...root.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['one', 'two']);
    expect([...root.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual(['first', 'second']);
    expect(root.querySelector('li p')).toBeNull();
  });

  it('shows task items as disabled checkboxes that cannot be toggled', () => {
    const root = render('- [x] done\n- [ ] todo\n- plain');
    const boxes = [...root.querySelectorAll<HTMLInputElement>('li.task input')];
    expect(boxes.map((box) => [box.type, box.checked, box.disabled])).toEqual([
      ['checkbox', true, true],
      ['checkbox', false, true],
    ]);
    expect(root.querySelectorAll('li.task')).toHaveLength(2);
  });

  it('renders tables with a header and a body', () => {
    const root = render('| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |');
    expect([...root.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['A', 'B']);
    expect([...root.querySelectorAll('tbody tr')].map((row) => row.textContent)).toEqual(['12', '34']);
  });

  it('keeps line breaks within a paragraph', () => {
    expect(render('one<br>two').querySelector('br')).not.toBeNull();
  });
});

describe('links', () => {
  it('opens in a new tab and does not navigate the panel', () => {
    const root = render('[the PR](https://github.com/acme/app/pull/1)');
    const link = root.querySelector('a')!;
    expect(link.title).toBe('https://github.com/acme/app/pull/1');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(fake.mock.tabs.create).toHaveBeenCalledWith({ url: 'https://github.com/acme/app/pull/1' });
  });

  it('ignores clicks that are not on a link', () => {
    render('plain text')
      .querySelector('p')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(fake.mock.tabs.create).not.toHaveBeenCalled();
  });

  it('opens a link from inside its formatting', () => {
    const root = render('[**bold**](https://example.com/x)');
    root.querySelector('strong')!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(fake.mock.tabs.create).toHaveBeenCalledWith({ url: 'https://example.com/x' });
  });

  it('drops a link with an unsafe address, keeping its text', () => {
    const root = render('[click](javascript:alert(1))');
    expect(root.querySelector('a')).toBeNull();
    expect(root.textContent).toContain('click');
  });
});

describe('folding', () => {
  const long = 'word '.repeat(100);

  it('shows a short description as it is, with no toggle', () => {
    const root = render('short', 360);
    expect(root.classList.contains('md')).toBe(true);
    expect(document.querySelector('.md-toggle')).toBeNull();
  });

  it('starts a long one folded, and unfolds and folds it again from the button', () => {
    render(long, 360);
    const wrapper = document.querySelector('.md-fold')!;
    const toggle = document.querySelector<HTMLButtonElement>('.md-toggle')!;
    expect(wrapper.classList.contains('folded')).toBe(true);
    expect(toggle.textContent).toBe('Show more');

    toggle.click();
    expect(wrapper.classList.contains('folded')).toBe(false);
    expect(toggle.textContent).toBe('Show less');

    toggle.click();
    expect(wrapper.classList.contains('folded')).toBe(true);
    expect(toggle.textContent).toBe('Show more');
  });

  it('folds after 360 characters by default, and exactly at the limit not yet', () => {
    expect(renderMarkdown('a'.repeat(360)).classList.contains('md')).toBe(true);
    expect(renderMarkdown('a'.repeat(361)).classList.contains('md-fold')).toBe(true);
  });
});
