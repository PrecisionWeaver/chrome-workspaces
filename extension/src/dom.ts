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
