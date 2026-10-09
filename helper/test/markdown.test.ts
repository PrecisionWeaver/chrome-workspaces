import { describe, expect, it } from 'vitest';
import { inlineText, parseInline, parseMarkdown } from '../../shared/markdown';

describe('parseInline', () => {
  it('reads code, bold, italic, strike, links and bare URLs', () => {
    expect(parseInline('a `b` **c** *d* ~~e~~ [f](https://x.example) https://y.example/z.')).toEqual([
      { t: 'text', v: 'a ' },
      { t: 'code', v: 'b' },
      { t: 'text', v: ' ' },
      { t: 'strong', c: [{ t: 'text', v: 'c' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'd' }] },
      { t: 'text', v: ' ' },
      { t: 'del', c: [{ t: 'text', v: 'e' }] },
      { t: 'text', v: ' ' },
      { t: 'link', href: 'https://x.example', c: [{ t: 'text', v: 'f' }] },
      { t: 'text', v: ' ' },
      { t: 'link', href: 'https://y.example/z', c: [{ t: 'text', v: 'https://y.example/z' }] },
      { t: 'text', v: '.' },
    ]);
  });

  it('leaves snake_case and a lone asterisk alone', () => {
    expect(inlineText(parseInline('use my_var_name and 2 * 3'))).toBe('use my_var_name and 2 * 3');
    expect(parseInline('my_var_name')).toEqual([{ t: 'text', v: 'my_var_name' }]);
  });

  it('never makes a link from a javascript: or data: address', () => {
    expect(parseInline('[x](javascript:alert) [y](data:text/html,hi)')).toEqual([{ t: 'text', v: 'x' }, { t: 'text', v: ' ' }, { t: 'text', v: 'y' }]);
  });

  it('shows an image as a labelled link and honors escapes', () => {
    expect(parseInline('![shot](https://x.example/a.png) \\*not em\\*')).toEqual([
      { t: 'link', href: 'https://x.example/a.png', c: [{ t: 'text', v: '🖼 shot' }] },
      { t: 'text', v: ' *not em*' },
    ]);
  });
});

describe('parseMarkdown', () => {
  it('reads headings, paragraphs and rules, dropping comments and HTML', () => {
    const blocks = parseMarkdown('<!-- template -->\n## Summary\nFirst line\nsecond line\n\n---\n<details><summary>More</summary>\nhidden\n</details>');
    expect(blocks.map((b) => b.t)).toEqual(['heading', 'p', 'hr', 'p']);
    expect(blocks[0]).toMatchObject({ level: 2 });
    expect(blocks[1]).toMatchObject({ c: [{ v: 'First line' }, { t: 'br' }, { v: 'second line' }] });
    expect(JSON.stringify(blocks[3])).toContain('hidden');
    expect(JSON.stringify(blocks)).not.toContain('<');
  });

  it('reads nested bullet, numbered and task lists', () => {
    const [list, numbered] = parseMarkdown('- one\n  - nested\n- [x] done\n- [ ] todo\n\n1. a\n2. b');
    expect(list).toMatchObject({ t: 'list', ordered: false });
    if (list.t !== 'list') throw new Error('not a list');
    expect(list.items.map((i) => i.task)).toEqual([null, true, false]);
    expect(list.items[0].c.map((b) => b.t)).toEqual(['p', 'list']);
    expect(numbered).toMatchObject({ t: 'list', ordered: true });
  });

  it('reads fenced code verbatim, including markdown and blank lines inside', () => {
    expect(parseMarkdown('```php\n$a = **b**;\n\n- x\n```\nafter')).toEqual([
      { t: 'code', lang: 'php', v: '$a = **b**;\n\n- x' },
      { t: 'p', c: [{ t: 'text', v: 'after' }] },
    ]);
  });

  it('reads tables and quotes', () => {
    const [table, quote] = parseMarkdown('| A | B |\n|---|:-:|\n| 1 | `2` |\n| 3 | 4 |\n\n> quoted **text**\n> more');
    expect(table).toMatchObject({ t: 'table' });
    if (table.t !== 'table') throw new Error('not a table');
    expect(table.head.map(inlineText)).toEqual(['A', 'B']);
    expect(table.rows.map((r) => r.map(inlineText))).toEqual([['1', '2'], ['3', '4']]);
    expect(quote).toMatchObject({ t: 'quote' });
  });

  it('keeps an unclosed fence and a stray pipe from swallowing the rest', () => {
    expect(parseMarkdown('a | b\n\nplain').map((b) => b.t)).toEqual(['p', 'p']);
    expect(parseMarkdown('```\nopen')[0]).toMatchObject({ t: 'code', v: 'open' });
  });

  it('returns nothing for empty text', () => {
    expect(parseMarkdown('  \n ')).toEqual([]);
  });
});
