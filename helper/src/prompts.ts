import { readFileSync } from 'node:fs';
import type { Prompt } from '../../shared/protocol';

const HEADING = /^\*\*(.+?)\*\*$/;
const BULLET = /^\s*-\s+(.*\S)\s*$/;

/** Each `**Heading**` line starts a section; each `- ` bullet under it is one prompt. */
export function parsePrompts(markdown: string): Prompt[] {
  const prompts: Prompt[] = [];
  let section = '';
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.trim().match(HEADING);
    if (heading) section = heading[1].trim();
    else {
      const bullet = line.match(BULLET);
      if (bullet) prompts.push({ section, text: bullet[1] });
    }
  }
  return prompts;
}

/** Read on every request so edits to the note show up without restarting the helper. */
export function readPrompts(file: string): Prompt[] {
  try {
    return parsePrompts(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
