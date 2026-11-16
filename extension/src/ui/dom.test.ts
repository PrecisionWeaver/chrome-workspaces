// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { confirmButton, createArming, el, hoverTip, icon, installHoverTips, promptCard } from './dom';
import { isolateDocumentListeners } from '../../testing/fixtures';

describe('el', () => {
  it('makes an element with text and classes, as text rather than markup', () => {
    const node = el('span', '<b>hi</b>', 'a b');
    expect(node.tagName).toBe('SPAN');
    expect(node.textContent).toBe('<b>hi</b>');
    expect(node.children).toHaveLength(0);
    expect(node.className).toBe('a b');
  });

  it('adds no class attribute when given none', () => {
    expect(el('div').hasAttribute('class')).toBe(false);
  });
});

describe('promptCard', () => {
  const render = (text: string) => promptCard(text).map((node) => [(node as HTMLElement).tagName, (node as HTMLElement).className, node.textContent]);

  it('sets a leading slash command apart from the rest', () => {
    expect(render('/review-pr - Review PR-URL')).toEqual([
      ['CODE', 'prompt-command', '/review-pr'],
      ['SPAN', 'prompt-text', 'Review PR-URL'],
    ]);
    expect(render('/plan:fast do the thing')).toEqual([
      ['CODE', 'prompt-command', '/plan:fast'],
      ['SPAN', 'prompt-text', 'do the thing'],
    ]);
  });

  it('shows a lone command by itself', () => {
    expect(render('/compact')).toEqual([['CODE', 'prompt-command', '/compact']]);
  });

  it('shows anything else as plain text, including a slash that is not at the start', () => {
    expect(render('Fix PROJ-123')).toEqual([['SPAN', 'prompt-text', 'Fix PROJ-123']]);
    expect(render('see /review later')).toEqual([['SPAN', 'prompt-text', 'see /review later']]);
  });

  it('keeps a multi-line body together', () => {
    expect(render('/go first\nsecond')[1]).toEqual(['SPAN', 'prompt-text', 'first\nsecond']);
  });
});

describe('icon', () => {
  it('references the sprite symbol by name', () => {
    const svg = icon('github');
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.getAttribute('class')).toBe('icon');
    expect(svg.querySelector('use')?.getAttribute('href')).toBe('#i-github');
  });
});

describe('hover tips', () => {
  isolateDocumentListeners();

  it('shows the tip of the element under the pointer at once, and drops it on leaving', () => {
    installHoverTips();
    const bar = el('div');
    const inner = el('span');
    bar.append(inner);
    hoverTip(bar, '2026-03-09\n1.0M tokens');
    const plain = el('div');
    document.body.append(bar, plain);
    inner.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(document.querySelectorAll('.hover-tip')).toHaveLength(1);
    expect(document.querySelector('.hover-tip')!.textContent).toBe('2026-03-09\n1.0M tokens');
    plain.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    expect(document.querySelector('.hover-tip')).toBeNull();
    bar.remove();
    plain.remove();
  });

  it('sits the tip against the target inside the element when it names one', () => {
    installHoverTips();
    const bar = el('div');
    const fill = el('span', '', 'fill');
    bar.append(fill);
    hoverTip(bar, 'tip', '.fill');
    document.body.append(bar);
    bar.getBoundingClientRect = () => ({ left: 0, top: 0, bottom: 100, width: 10, height: 100 }) as DOMRect;
    fill.getBoundingClientRect = () => ({ left: 0, top: 80, bottom: 100, width: 10, height: 20 }) as DOMRect;
    fill.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    // Above the fill (top 80), not the bar (top 0), which has no room above and would drop the tip below it.
    expect(parseFloat((document.querySelector('.hover-tip') as HTMLElement).style.top)).toBeGreaterThan(0);
    expect(parseFloat((document.querySelector('.hover-tip') as HTMLElement).style.top)).toBeLessThan(80);
    bar.remove();
  });
});

describe('confirmButton', () => {
  function make(arming = createArming(() => {}, 4000)) {
    const run = vi.fn();
    const button = el('button');
    confirmButton(arming, 'archive:ws-a', button, (armed) => (button.textContent = armed ? 'Sure?' : 'Archive'), run);
    return { button, run, arming };
  }

  it('runs on the second click only, relabelling itself in place after the first', () => {
    const { button, run } = make();
    expect(button.textContent).toBe('Archive');
    expect(button.classList.contains('armed')).toBe(false);
    button.click();
    expect(run).not.toHaveBeenCalled();
    expect(button.textContent).toBe('Sure?');
    expect(button.classList.contains('armed')).toBe(true);
    button.click();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('comes back armed when it is drawn again while its key is armed, so a redraw cannot lose the first click', () => {
    const { button, arming } = make();
    button.click();
    const { button: redrawn, run } = make(arming);
    expect(redrawn.textContent).toBe('Sure?');
    expect(redrawn.classList.contains('armed')).toBe(true);
    redrawn.click();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('is a plain button carrying its key for keepFocus, and keeps the click from its row', () => {
    const { button } = make();
    expect(button.type).toBe('button');
    expect(button.dataset.focus).toBe('archive:ws-a');
    const row = document.createElement('li');
    const seen = vi.fn();
    row.addEventListener('click', seen);
    row.append(button);
    button.click();
    expect(seen).not.toHaveBeenCalled();
  });
});
