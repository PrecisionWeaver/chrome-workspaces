export const MAX_BRANCH_LENGTH = 100;

/** A branch name git's check-ref-format accepts, in the plain form a workspace needs: letters, digits, `.`, `_`, `-` and `/`. */
export function isBranchName(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BRANCH_LENGTH) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) return false;
  if (value.startsWith('-') || value.startsWith('/') || value.startsWith('.')) return false;
  if (value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false;
  return !value.includes('..') && !value.includes('//') && !value.includes('@{') && !value.includes('/.');
}

/** A workspace name as a branch: spaces become dashes, anything git would refuse is dropped. Empty when nothing is left. */
export function slugBranch(name: string): string {
  let slug = name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/\/\./g, '/')
    .replace(/\.lock$/, '')
    .replace(/^[-/.]+/, '')
    .replace(/[/.]+$/, '')
    .slice(0, MAX_BRANCH_LENGTH);
  slug = slug.replace(/[/.]+$/, '');
  return isBranchName(slug) ? slug : '';
}
