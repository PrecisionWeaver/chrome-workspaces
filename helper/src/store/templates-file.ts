import { readFileSync } from 'node:fs';
import { parseTemplates, type Template } from '../../../shared/workspaces/templates';
import { errorMessage } from '../../../shared/protocol/errors';

/**
 * Templates kept in a JSON file the team shares (a list in the shape the panel stores). Read on every request so
 * edits show up without a restart. An entry's id is its place in the list, so a saved pick survives reordering only by name.
 */
export function readTemplatesFile(file: string | null): Template[] {
  if (!file) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${errorMessage(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${file} must hold a list of templates`);
  return parseTemplates(parsed.map((entry, index) => (typeof entry === 'object' && entry !== null ? { id: `team:${index}`, ...entry } : entry)));
}
