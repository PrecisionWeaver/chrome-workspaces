const unescapeXml = (value: string): string => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * The Node binary `setup` recorded: the first program argument in the LaunchAgent's plist, and the one the native
 * host wrapper execs. Both are the full path of the Node that ran setup, so a Node upgrade through nvm or a
 * versioned Homebrew path leaves them pointing at nothing. Null for a file without one.
 */
export function plistNodePath(plist: string): string | null {
  const match = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]+)<\/string>/.exec(plist);
  return match ? unescapeXml(match[1]) : null;
}

export function wrapperNodePath(wrapper: string): string | null {
  return /\bexec "([^"]+)"/.exec(wrapper)?.[1] ?? null;
}
