/** One URL per line (or space); a bare domain gets https://. Returns the bad entries, if any, instead of urls. */
export function parseTabUrls(text: string): { urls: string[]; invalid: string[] } {
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const entry of text.split(/\s+/).filter(Boolean)) {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(entry) ? entry : `https://${entry}`;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.push(url.href);
      else invalid.push(entry);
    } catch {
      invalid.push(entry);
    }
  }
  return { urls, invalid };
}

/** Origin and path, so a trailing slash, query or fragment does not make the same page look new. */
function normalize(url: string): string {
  try {
    const { origin, pathname } = new URL(url);
    return origin + pathname.replace(/\/$/, '');
  } catch {
    return url;
  }
}

/** A tab on the page, or on a page beneath it: a PR's `/files` tab counts as the PR. */
export function showsPage(tabUrl: string | undefined, url: string): boolean {
  if (!tabUrl) return false;
  const tab = normalize(tabUrl);
  const page = normalize(url);
  return tab === page || tab.startsWith(`${page}/`);
}
