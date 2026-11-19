/** `value` as one double-quoted shell word: a quote, backslash, `$` or backtick in it is escaped, so a path with one cannot end the word or run anything. */
export const doubleQuote = (value: string): string => `"${value.replace(/[\\"$`]/g, '\\$&')}"`;
