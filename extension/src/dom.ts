export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

/** Splits a leading slash command off a prompt, so cards can set the command apart. */
export function promptCard(text: string): Node[] {
  const match = text.match(/^(\/[\w:-]+)\s*(.*)$/s);
  if (!match) return [el('span', text, 'prompt-text')];
  const nodes: Node[] = [el('code', match[1], 'prompt-command')];
  if (match[2]) nodes.push(el('span', match[2].replace(/^-\s*/, ''), 'prompt-text'));
  return nodes;
}

/** The disclosure chevron: down when open, turned right when closed. The same icon as the section headers. */
export function caret(open: boolean): SVGSVGElement {
  const svg = icon('chevron-down');
  svg.classList.add('caret');
  svg.classList.toggle('open', open);
  return svg;
}

/** An icon from the sprite in panel.html, sized and coloured by the surrounding button. */
export function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

/**
 * Wires a page's Back button to `close`, and Escape too while `isOpen` says the page is showing.
 * A page that leaves Escape to its terminal passes no `isOpen`.
 */
export function wireBack(buttonId: string, close: () => void, isOpen?: () => boolean): void {
  $<HTMLButtonElement>(buttonId).addEventListener('click', close);
  if (!isOpen) return;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen()) close();
  });
}
