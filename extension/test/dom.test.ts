// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { el, icon, promptCard } from '../src/dom';

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
