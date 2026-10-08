// Used by the extension bundle — keep this free of Node imports.

export interface PromptValues {
  prUrl: string | null;
  ticket: string | null;
}

/** Fills standalone `PR-URL` and `<PROJECT>-XXX` (e.g. `PROJ-XXX`) when known; every other placeholder is left for the user to edit. */
export function fillPrompt(text: string, { prUrl, ticket }: PromptValues): string {
  let filled = text;
  if (prUrl) filled = filled.replace(/PR-URL(?![\w-])/g, () => prUrl);
  if (ticket) filled = filled.replace(/\b[A-Z][A-Z0-9]*-XXX(?![\w-])/g, () => ticket);
  return filled;
}
