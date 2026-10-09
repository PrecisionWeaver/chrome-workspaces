import { parseMarkdown, type Block, type Inline } from '../../shared/markdown';
import { el } from './dom';

function inline(nodes: readonly Inline[]): Node[] {
  return nodes.map((n): Node => {
    switch (n.t) {
      case 'text':
        return document.createTextNode(n.v);
      case 'code':
        return el('code', n.v);
      case 'br':
        return document.createElement('br');
      case 'link': {
        const a = el('a');
        a.href = n.href;
        a.title = n.href;
        a.append(...inline(n.c));
        return a;
      }
      default: {
        const node = document.createElement(n.t === 'strong' ? 'strong' : n.t === 'em' ? 'em' : 'del');
        node.append(...inline(n.c));
        return node;
      }
    }
  });
}

function block(b: Block): Node {
  switch (b.t) {
    case 'heading': {
      // Description headings sit below the page's own, so they are shown small.
      const h = el(`h${Math.min(b.level + 2, 6)}` as 'h3');
      h.append(...inline(b.c));
      return h;
    }
    case 'p': {
      const p = el('p');
      p.append(...inline(b.c));
      return p;
    }
    case 'code': {
      const pre = el('pre');
      pre.append(el('code', b.v));
      return pre;
    }
    case 'quote': {
      const q = el('blockquote');
      q.append(...b.c.map(block));
      return q;
    }
    case 'hr':
      return el('hr');
    case 'list': {
      const list = el(b.ordered ? 'ol' : 'ul');
      for (const item of b.items) {
        const li = el('li');
        if (item.task !== null) {
          li.className = 'task';
          const box = el('input');
          box.type = 'checkbox';
          box.checked = item.task;
          // A checkbox here is a picture of GitHub's, not something to toggle.
          box.disabled = true;
          li.append(box);
        }
        li.append(...item.c.map((child) => (child.t === 'p' && item.c.length === 1 ? inlineWrap(child.c) : block(child))));
        list.append(li);
      }
      return list;
    }
    case 'table': {
      const table = el('table');
      const head = el('tr');
      head.append(...b.head.map((cell) => cellWith('th', cell)));
      table.append(wrap('thead', head));
      const body = el('tbody');
      for (const row of b.rows) {
        const tr = el('tr');
        tr.append(...row.map((cell) => cellWith('td', cell)));
        body.append(tr);
      }
      table.append(body);
      return table;
    }
  }
}

const inlineWrap = (nodes: readonly Inline[]): Node => {
  const span = el('span');
  span.append(...inline(nodes));
  return span;
};

function cellWith(tag: 'th' | 'td', nodes: readonly Inline[]): HTMLElement {
  const cell = el(tag);
  cell.append(...inline(nodes));
  return cell;
}

function wrap(tag: 'thead' | 'tbody', child: Node): HTMLElement {
  const node = el(tag);
  node.append(child);
  return node;
}

/**
 * A PR description as formatted content. It is built from a parsed tree, never from HTML, and links
 * open in a new tab instead of navigating the panel. A long description starts folded.
 */
export function renderMarkdown(source: string, foldAfter = 360): HTMLElement {
  const root = el('div', '', 'md');
  root.append(...parseMarkdown(source).map(block));
  root.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest('a');
    if (!link) return;
    event.preventDefault();
    void chrome.tabs.create({ url: link.href });
  });
  if (source.length <= foldAfter) return root;

  const wrapper = el('div', '', 'md-fold folded');
  const toggle = el('button', 'Show more', 'md-toggle');
  toggle.type = 'button';
  toggle.addEventListener('click', () => {
    const folded = wrapper.classList.toggle('folded');
    toggle.textContent = folded ? 'Show more' : 'Show less';
  });
  wrapper.append(root, toggle);
  return wrapper;
}
