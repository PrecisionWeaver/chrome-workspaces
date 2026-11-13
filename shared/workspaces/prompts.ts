// Used by the extension bundle — keep this free of Node imports.

export interface PromptValues {
  prUrl: string | null;
  ticket: string | null;
}

/** A pull request link whose number is still a placeholder, e.g. `https://github.com/acme/web-app/pull/XXXX`. */
const PLACEHOLDER_PR_LINK = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/X{2,}(?![\w-])/g;

/** Fills standalone `PR-URL`, a PR link ending `/pull/XXXX`, and `<PROJECT>-XXX` (e.g. `PROJ-XXX`) when known; every other placeholder is left for the user to edit. */
export function fillPrompt(text: string, { prUrl, ticket }: PromptValues): string {
  let filled = text;
  if (prUrl) filled = filled.replace(PLACEHOLDER_PR_LINK, () => prUrl).replace(/PR-URL(?![\w-])/g, () => prUrl);
  if (ticket) filled = filled.replace(/\b[A-Z][A-Z0-9]*-XXX(?![\w-])/g, () => ticket);
  return filled;
}
