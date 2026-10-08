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
