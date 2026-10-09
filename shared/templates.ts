export interface Template {
  id: string;
  name: string;
  /** A repo directory, or '' for the default. */
  repo: string;
  /** A model alias, or '' for the default. */
  model: string;
  /** The Tabs box, one URL per line. */
  tabs: string;
  /** The first message, or '' to start blank. */
  message: string;
  window: 'new' | 'here';
}

export const MAX_TEMPLATES = 30;
const MAX_NAME = 60;

const str = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

/** The templates in stored data, keeping only well-formed entries, since storage can hold anything. */
export function parseTemplates(stored: unknown): Template[] {
  if (!Array.isArray(stored)) return [];
  const result: Template[] = [];
  for (const raw of stored) {
    if (typeof raw !== 'object' || raw === null) continue;
    const t = raw as Record<string, unknown>;
    const name = str(t.name, MAX_NAME).trim();
    if (!name || typeof t.id !== 'string') continue;
    result.push({
      id: t.id,
      name,
      repo: str(t.repo, 1024),
      model: str(t.model, 64),
      tabs: str(t.tabs, 8000),
      message: str(t.message, 8000),
      window: t.window === 'here' ? 'here' : 'new',
    });
  }
  return result.slice(0, MAX_TEMPLATES);
}

/** Adds a template, or replaces the one with the same name (ignoring case), keeping its place. */
export function upsertTemplate(list: readonly Template[], template: Template): Template[] {
  const at = list.findIndex((t) => t.name.toLowerCase() === template.name.toLowerCase());
  if (at !== -1) return list.map((t, i) => (i === at ? { ...template, id: t.id } : t));
  return [...list, template].slice(-MAX_TEMPLATES);
}

export const removeTemplate = (list: readonly Template[], id: string): Template[] => list.filter((t) => t.id !== id);
