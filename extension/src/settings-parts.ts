import { el } from './dom';

/** Small builders shared by the Settings cards. */

export const row = (label: string, value: string | Node, title = ''): HTMLElement => {
  const line = el('div', '', 'kv');
  line.title = title;
  line.append(el('span', label, 'k'));
  const v = el('span', '', 'v');
  v.append(value);
  line.append(v);
  return line;
};

export const card = (title: string, ...children: Node[]): HTMLElement => {
  const node = el('section', '', 'settings-card');
  // Matches a card across renders; the count after a "·" changes from poll to poll.
  node.dataset.key = title.split(' · ')[0];
  node.append(el('h3', title), ...children);
  return node;
};

/** Spans a card across every column once the view is wide enough for more than one. */
export const wide = (node: HTMLElement): HTMLElement => {
  node.classList.add('wide');
  return node;
};

export const actions = (...buttons: Node[]): HTMLElement => {
  const node = el('div', '', 'settings-actions');
  node.append(...buttons);
  return node;
};
