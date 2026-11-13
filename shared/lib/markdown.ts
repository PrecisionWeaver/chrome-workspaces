// A small GitHub-flavored markdown parser for PR descriptions. It produces a tree and never HTML,
// so the panel builds DOM nodes from it and nothing in an untrusted description can inject markup.
// Covers what PR templates use: headings, lists with tasks, tables, quotes, code, and inline styles.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'code'; v: string }
  | { t: 'br' }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'heading'; level: number; c: Inline[] }
  | { t: 'p'; c: Inline[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'quote'; c: Block[] }
  | { t: 'hr' }
  | { t: 'list'; ordered: boolean; items: { task: boolean | null; c: Block[] }[] }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][] };

const SAFE_HREF = /^https?:\/\//i;

/** Drops comments and raw HTML, keeping the text inside tags and turning <br> into a line break. */
function stripHtml(source: string): string {
  return source
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/?(?:details|summary|p|div|span|img|a|b|i|em|strong|code|pre|ul|ol|li|h[1-6]|table|thead|tbody|tr|td|th|hr|sub|sup|kbd|picture|source)\b[^>]*>/gi,
      '',
    );
}

const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let plain = '';
  const flush = () => {
    if (plain) out.push({ t: 'text', v: plain });
    plain = '';
  };
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    let m: RegExpMatchArray | null;

    if (text[i] === '\\' && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~<>]/.test(text[i + 1])) {
      plain += text[i + 1];
      i += 2;
    } else if (text[i] === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
    } else if ((m = rest.match(/^(`+)([\s\S]*?[^`])\1(?!`)/))) {
      flush();
      out.push({ t: 'code', v: m[2].replace(/^ (.*) $/, '$1') });
      i += m[0].length;
    } else if ((m = rest.match(/^!?\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/))) {
      flush();
      const label = m[1] || m[2];
      // An image is shown as a link to it, as the panel does not load remote pictures.
      const c = m[0].startsWith('!') ? [{ t: 'text', v: `🖼 ${m[1] || 'image'}` } as Inline] : parseInline(label);
      out.push(SAFE_HREF.test(m[2]) ? { t: 'link', href: m[2], c } : { t: 'text', v: label });
      i += m[0].length;
    } else if ((m = rest.match(/^<(https?:\/\/[^>\s]+)>/)) || ((m = rest.match(/^https?:\/\/[^\s<>)\]]*[^\s<>)\].,;:!?'"]/)) && !isWord(text[i - 1]))) {
      flush();
      const href = m[1] ?? m[0];
      out.push({ t: 'link', href, c: [{ t: 'text', v: href }] });
      i += m[0].length;
    } else if ((m = rest.match(/^(\*\*|__)(?=\S)([\s\S]*?\S)\1/)) && (m[1] === '**' || !isWord(text[i - 1]))) {
      flush();
      out.push({ t: 'strong', c: parseInline(m[2]) });
      i += m[0].length;
    } else if ((m = rest.match(/^~~(?=\S)([\s\S]*?\S)~~/))) {
      flush();
      out.push({ t: 'del', c: parseInline(m[1]) });
      i += m[0].length;
    } else if ((m = rest.match(/^([*_])(?=\S)([\s\S]*?\S)\1/)) && (m[1] === '*' || (!isWord(text[i - 1]) && !isWord(text[i + m[0].length])))) {
      flush();
      out.push({ t: 'em', c: parseInline(m[2]) });
      i += m[0].length;
    } else {
      plain += text[i++];
    }
  }
  flush();
  return out;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));

function startsBlock(line: string, next: string | undefined): boolean {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    HR.test(line) ||
    ITEM.test(line) ||
    /^\s{0,3}>/.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_RULE.test(next) && next.includes('-'))
  );
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m: RegExpMatchArray | null;
    if (!line.trim()) {
      i++;
    } else if ((m = line.match(FENCE))) {
      const [, fence, lang] = m;
      const body: string[] = [];
      for (i++; i < lines.length && !new RegExp(`^\\s{0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i]); i++) body.push(lines[i]);
      i++;
      blocks.push({ t: 'code', lang, v: body.join('\n') });
    } else if ((m = line.match(HEADING))) {
      blocks.push({ t: 'heading', level: m[1].length, c: parseInline(m[2]) });
      i++;
    } else if (HR.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
    } else if (line.includes('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line).map(parseInline);
      const rows: Inline[][][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) rows.push(splitRow(lines[i]).map(parseInline));
      blocks.push({ t: 'table', head, rows });
    } else if (/^\s{0,3}>/.test(line)) {
      const quoted: string[] = [];
      for (; i < lines.length && /^\s{0,3}>/.test(lines[i]); i++) quoted.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
      blocks.push({ t: 'quote', c: parseBlocks(quoted) });
    } else if ((m = line.match(ITEM))) {
      const base = m[1].length;
      const ordered = /\d/.test(m[2]);
      const items: { task: boolean | null; c: Block[] }[] = [];
      while (i < lines.length) {
        const item = lines[i].match(ITEM);
        if (!item || item[1].length !== base) break;
        let first = item[3];
        let task: boolean | null = null;
        const box = first.match(/^\[([ xX])\]\s+(.*)$/);
        if (box) {
          task = box[1] !== ' ';
          first = box[2];
        }
        const body = [first];
        // Following lines belong to the item while they are indented deeper, or are blank between such lines.
        for (i++; i < lines.length; i++) {
          const next = lines[i];
          if (!next.trim()) {
            if (i + 1 < lines.length && lines[i + 1].trim() && /^\s/.test(lines[i + 1]) && (lines[i + 1].match(/^\s*/)?.[0].length ?? 0) > base) body.push('');
            else break;
          } else if ((next.match(/^\s*/)?.[0].length ?? 0) > base) body.push(next.slice(Math.min(base + 2, next.match(/^\s*/)?.[0].length ?? 0)));
          else break;
        }
        items.push({ task, c: parseBlocks(body) });
      }
      blocks.push({ t: 'list', ordered, items });
    } else {
      const para = [line];
      for (i++; i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1]); i++) para.push(lines[i]);
      blocks.push({ t: 'p', c: parseInline(para.map((l) => l.trim()).join('\n')) });
    }
  }
  return blocks;
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(stripHtml(source).split('\n'));
}

/** The text of a parsed inline run, for titles and tests. */
export function inlineText(nodes: readonly Inline[]): string {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.v : n.t === 'br' ? ' ' : inlineText(n.c))).join('');
}
