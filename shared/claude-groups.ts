// Claude in Chrome's tools can't be told which window to use, so its tab group opens in whichever
// window was last focused. The workspace that opened one is found by timing: Mission Control
// records each Claude in Chrome tool call as it finishes, just after the call created the group.

/** Claude in Chrome titles its groups "Claude", behind a status emoji. */
export const CLAUDE_GROUP_TITLE = /Claude/;

/** How long after a group appears the call that created it can finish (navigate waits for the page to load). */
export const CALL_WINDOW_MS = 30_000;

// The group event can reach the extension a moment after the hook has stamped the call.
const SLACK_MS = 500;

export interface BrowserCall {
  workspaceId: string;
  /** Epoch ms. */
  at: number;
}

/** The workspace whose browser call opened a group first seen at `seenAt`: the first call to finish after it. */
export function groupOwner(seenAt: number, calls: readonly BrowserCall[]): string | null {
  let first: BrowserCall | null = null;
  for (const call of calls) {
    if (call.at < seenAt - SLACK_MS || call.at > seenAt + CALL_WINDOW_MS) continue;
    if (!first || call.at < first.at) first = call;
  }
  return first?.workspaceId ?? null;
}
