// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { keepFocus } from './focus';

let root: HTMLDivElement;
const button = (key: string, attribute: 'focus' | 'id' = 'focus') => {
  const node = document.createElement('button');
  node.dataset[attribute] = key;
  return node;
};

beforeEach(() => {
  document.body.replaceChildren();
  root = document.createElement('div');
  document.body.append(root);
});

describe('keepFocus', () => {
  it('puts focus back on the redrawn element with the same key', () => {
    root.append(button('a'), button('b'));
    root.querySelectorAll('button')[1].focus();
    keepFocus(root, () => root.replaceChildren(button('a'), button('b')));
    expect((document.activeElement as HTMLElement).dataset.focus).toBe('b');
  });

  it('finds a row by its id', () => {
    root.append(button('ws-1', 'id'));
    root.querySelector('button')?.focus();
    keepFocus(root, () => root.replaceChildren(button('ws-1', 'id')));
    expect((document.activeElement as HTMLElement).dataset.id).toBe('ws-1');
  });

  it('leaves focus alone when it was elsewhere or its element is gone', () => {
    const outside = button('x');
    document.body.append(outside);
    root.append(button('a'));
    outside.focus();
    keepFocus(root, () => root.replaceChildren(button('a')));
    expect(document.activeElement).toBe(outside);
    root.querySelector('button')?.focus();
    keepFocus(root, () => root.replaceChildren());
    expect(document.activeElement).toBe(document.body);
  });
});
