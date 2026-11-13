import type { ReviewRequest } from '../../../shared/protocol/protocol';
import { isDirectory } from '../platform/config';
import type { NewWorkspace } from '../store/workspace-store';

const PR_URL = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/;

export function isPullRequestUrl(url: string): boolean {
  return PR_URL.test(url);
}

export interface PrWorkspaceOptions {
  reviews: readonly ReviewRequest[];
  repoDirs: Record<string, string>;
  defaultCwd: string;
}

/** A PR's workspace is named `repo#number`, opens at the PR, and starts in the repo's mapped directory. */
export function prWorkspace(url: string, { reviews, repoDirs, defaultCwd }: PrWorkspaceOptions): NewWorkspace {
  const match = url.match(PR_URL);
  if (!match) throw new Error(`not a GitHub pull request url: ${url}`);
  const [, owner, repo, number] = match;
  const dir = repoDirs[`${owner}/${repo}`];
  return {
    name: `${repo}#${number}`,
    ticket: reviews.find((r) => r.url === url)?.ticket ?? null,
    cwd: dir && isDirectory(dir) ? dir : defaultCwd,
    url,
    pr: url,
  };
}
