export const MAX_PASTE_LENGTH = 20_000;

const BRACKET_START = '\x1b[200~';
const BRACKET_END = '\x1b[201~';

// Newline and tab stay. Everything else in the C0 range, delete, the C1 range, and the Unicode line
// and paragraph separators (U+2028, U+2029) go; the last two are built from their codes so the source
// holds no invisible characters.
const CONTROL = new RegExp(`[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');

/**
 * Text from a web page, made safe to put in a terminal: every control character except newline and tab
 * is removed. The ones that matter are ESC, which could end a bracketed paste early and have the rest
 * run as typed commands, and carriage return and backspace, which can rewrite what was pasted.
 */
export function sanitizePaste(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL, '').slice(0, MAX_PASTE_LENGTH);
}

/**
 * The bytes that deliver `text` as a paste: wrapped so a program that asks for bracketed paste (claude,
 * and a shell's line editor) takes it as text to edit instead of as keystrokes, and never submits it.
 */
export function asPaste(text: string): string {
  return `${BRACKET_START}${sanitizePaste(text)}${BRACKET_END}`;
}
