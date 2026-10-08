# Review Requests and Prompt Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show open PRs requesting Mike's review in the side panel, and start a workspace whose `claude` begins with a reusable prompt from the Obsidian vault, optionally tied to one of those PRs.

**Architecture:** The helper owns all data: it parses the vault's prompt note on request, polls `gh` for review requests and pushes them in the control `state` message, and stores `pr` and a one-shot `prompt` on each workspace. The launch command passes the prompt to `claude` through the `CW_PROMPT` environment variable so it never becomes shell syntax. The panel gains a review-request section, a `+` menu, and a prompt picker in a new `extension/src/launcher.ts`.

**Tech Stack:** TypeScript, Node 22, `ws`, `node-pty`, vitest, esbuild, Chrome MV3 side panel.

**Spec:** `docs/superpowers/specs/2026-10-07-review-requests-and-prompts-design.md`

Run every command from the repo root, `/Users/me/Documents/Websites/chrome-workspaces`.

---

## File map

| File | Change |
|---|---|
| `shared/protocol.ts` | `Prompt`, `ReviewRequest`, `ReviewsState`, `MAX_PROMPT_LENGTH`; `Workspace.pr`/`prompt`; new control messages |
| `shared/prompts.ts` | **new** `fillPrompt` (used by the panel, tested from the helper suite) |
| `helper/src/workspace-store.ts` | `pr`/`prompt` on create, `findByPr`, `clearPrompt`, load old files |
| `helper/src/launch.ts` | `CW_PROMPT` first message |
| `helper/src/prompts.ts` | **new** parse/read the vault note |
| `helper/src/reviews.ts` | **new** parse `gh` output, `ReviewsPoller` |
| `helper/src/pr-workspace.ts` | **new** PR URL validation and PR workspace defaults |
| `helper/src/config.ts` | `promptsFile`, `repoDirs`, shared `isDirectory` |
| `helper/src/control.ts` | create with `pr`/`prompt`, `listPrompts`, `refreshReviews`, reviews in state |
| `helper/src/api.ts` | `pr`/`prompt` on `POST /workspaces` |
| `helper/src/main.ts` | wire poller, prompts, config; clear prompt after launch |
| `scripts/setup.ts` | keep unmanaged config fields |
| `helper/test/harness.ts` | fakes for reviews, prompts, repoDirs |
| `extension/src/launcher.ts` | **new** review list + prompt picker |
| `extension/src/panel.ts`, `panel.html`, `panel.css` | `+` menu, reviews section, launch view |
| `README.md` | usage and config |

---

### Task 1: Workspace `pr` and `prompt` fields

**Files:**
- Modify: `shared/protocol.ts`
- Modify: `helper/src/workspace-store.ts`
- Modify: `helper/test/workspace-store.test.ts`, `helper/test/launch.test.ts:5-14`, `helper/test/pairing.test.ts:5-7`

- [ ] **Step 1: Write the failing tests**

Append to the `describe('WorkspaceStore', ...)` block in `helper/test/workspace-store.test.ts`:

```ts
  it('records the PR and prompt a workspace was created with, defaulting to null', () => {
    const file = tempFile();
    const store = new WorkspaceStore(file);
    const a = store.create({ name: 'app#1', cwd: '/tmp', pr: 'https://github.com/o/app/pull/1', prompt: 'review it' });
    const b = store.create({ name: 'b', cwd: '/tmp' });
    expect(new WorkspaceStore(file).get(a.id)).toMatchObject({ pr: 'https://github.com/o/app/pull/1', prompt: 'review it' });
    expect(store.get(b.id)).toMatchObject({ pr: null, prompt: null });
  });

  it('finds workspaces by PR url', () => {
    const store = new WorkspaceStore(tempFile());
    const a = store.create({ name: 'a', cwd: '/tmp', pr: 'https://github.com/o/r/pull/1' });
    expect(store.findByPr('https://github.com/o/r/pull/1')?.id).toBe(a.id);
    expect(store.findByPr('https://github.com/o/r/pull/2')).toBeUndefined();
  });

  it('clears a prompt once, persisting it', () => {
    const file = tempFile();
    const store = new WorkspaceStore(file);
    const a = store.create({ name: 'a', cwd: '/tmp', prompt: 'go' });
    let changes = 0;
    store.onChange(() => changes++);
    store.clearPrompt(a.id);
    store.clearPrompt(a.id);
    expect(new WorkspaceStore(file).get(a.id)?.prompt).toBeNull();
    expect(changes).toBe(1);
  });

  it('loads workspaces saved before pr and prompt existed', () => {
    const file = tempFile();
    const old = { id: 'ws-00000001', name: 'a', ticket: null, cwd: '/tmp', url: null, windowId: null, lastTabUrls: [], createdAt: '2026-01-01T00:00:00Z' };
    writeFileSync(file, JSON.stringify({ workspaces: [old] }));
    expect(new WorkspaceStore(file).get('ws-00000001')).toMatchObject({ pr: null, prompt: null });
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run helper/test/workspace-store.test.ts`
Expected: FAIL (`findByPr`/`clearPrompt` is not a function; `pr` undefined).

- [ ] **Step 3: Extend the protocol**

In `shared/protocol.ts`, add after `NATIVE_HOST_NAME`:

```ts
export const MAX_PROMPT_LENGTH = 8000;
```

Add two fields to `Workspace`, after `lastTabUrls`:

```ts
  /** GitHub PR URL the workspace was created to work on. */
  pr: string | null;
  /** First message for claude; cleared once a session has started with it. */
  prompt: string | null;
```

- [ ] **Step 4: Implement in the store**

In `helper/src/workspace-store.ts`, extend `NewWorkspace`:

```ts
export interface NewWorkspace {
  name: string;
  ticket?: string | null;
  cwd: string;
  url?: string | null;
  pr?: string | null;
  prompt?: string | null;
}
```

In `create`, add to the workspace literal after `lastTabUrls: [],`:

```ts
      pr: input.pr ?? null,
      prompt: input.prompt ?? null,
```

Add after `findByTicket`:

```ts
  findByPr(url: string): Workspace | undefined {
    return this.list().find((ws) => ws.pr === url);
  }
```

Add after `rename`:

```ts
  clearPrompt(id: string): void {
    const ws = this.require(id);
    if (ws.prompt === null) return;
    ws.prompt = null;
    this.save();
  }
```

Replace the `return` inside `load`'s `try`:

```ts
      const { workspaces } = JSON.parse(readFileSync(this.file, 'utf8')) as { workspaces: Workspace[] };
      // Files written before a field existed load with it unset.
      return workspaces.map((ws) => ({ ...ws, pr: ws.pr ?? null, prompt: ws.prompt ?? null }));
```

- [ ] **Step 5: Update the other `Workspace` fixtures**

`helper/test/launch.test.ts`: add `pr: null,` and `prompt: null,` after `lastTabUrls: [],` in the `workspace` constant.

`helper/test/pairing.test.ts:6`:

```ts
  return { id, name: id, ticket: null, cwd: '/tmp', url: null, windowId, lastTabUrls, pr: null, prompt: null, createdAt };
```

- [ ] **Step 6: Run the suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: all PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add shared/protocol.ts helper/src/workspace-store.ts helper/test/workspace-store.test.ts helper/test/launch.test.ts helper/test/pairing.test.ts
git commit -m "feat(helper): store a PR and a one-shot prompt per workspace"
```

---

### Task 2: Launch claude with the workspace prompt

**Files:**
- Modify: `helper/src/launch.ts`
- Modify: `helper/src/main.ts:40-45`
- Test: `helper/test/launch.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe('launchSpec', ...)`:

```ts
  it('sends the prompt as the first message through the environment, never the command', () => {
    const prompt = `/code-review "it's" $(touch /tmp/pwned) \`id\``;
    const spec = launchSpec({ ...workspace, prompt }, { shell: '/bin/zsh', resumeId: null });
    expect(spec.args[3]).toBe(`${start(' "$CW_PROMPT"')}; unset CW_PROMPT; exec /bin/zsh -l -i`);
    expect(spec.env?.CW_PROMPT).toBe(prompt);
  });

  it('resumes rather than re-sending the prompt', () => {
    const spec = launchSpec({ ...workspace, prompt: 'go' }, { shell: '/bin/zsh', resumeId: RESUME });
    expect(spec.args[3]).toBe(`${start(` --resume ${RESUME}`)}; exec /bin/zsh -l -i`);
    expect(spec.env).not.toHaveProperty('CW_PROMPT');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run helper/test/launch.test.ts`
Expected: the two new tests FAIL.

- [ ] **Step 3: Implement**

Replace the body of `launchSpec` in `helper/src/launch.ts`:

```ts
export function launchSpec(workspace: Workspace, { shell, resumeId }: LaunchOptions): SessionSpec {
  const env: Record<string, string> = { CW_WORKSPACE_ID: workspace.id };
  if (workspace.ticket) env.DEVSPACE_TICKET = workspace.ticket;

  let args = '';
  let cleanup = '';
  if (resumeId && SESSION_UUID.test(resumeId)) args = ` --resume ${resumeId}`;
  else if (workspace.prompt) {
    // The shell expands the prompt from the environment, so its text is never parsed as shell syntax.
    env.CW_PROMPT = workspace.prompt;
    args = ' "$CW_PROMPT"';
    cleanup = 'unset CW_PROMPT; ';
  }
  const claude = `if command -v hr >/dev/null 2>&1; then hr${args}; else claude${args}; fi`;

  return {
    id: workspace.id,
    command: shell,
    args: ['-l', '-i', '-c', `${claude}; ${cleanup}exec ${shell} -l -i`],
    cwd: workspace.cwd,
    env,
  };
}
```

- [ ] **Step 4: Clear the prompt once a session uses it**

In `helper/src/main.ts`, replace the `onUnknownSession` body:

```ts
  onUnknownSession: (id) => {
    const workspace = store.get(id);
    if (!workspace) return undefined;
    const resumeId = mcStatus.get(id)?.claudeSessionId ?? null;
    const spec = launchSpec(workspace, { shell, resumeId });
    const session = sessions.create(spec);
    if (spec.env?.CW_PROMPT !== undefined) store.clearPrompt(id);
    return session;
  },
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add helper/src/launch.ts helper/src/main.ts helper/test/launch.test.ts
git commit -m "feat(helper): start claude with a workspace's prompt on first launch"
```

---

### Task 3: Prompts from the vault

**Files:**
- Modify: `shared/protocol.ts`
- Create: `shared/prompts.ts`, `helper/src/prompts.ts`
- Test: `helper/test/prompts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `helper/test/prompts.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fillPrompt } from '../../shared/prompts';
import { parsePrompts, readPrompts } from '../src/prompts';

const NOTE = [
  '- loose prompt',
  '**Reviews**',
  ' - /code-review - PROJ-XXX - go/no-go',
  '- Is this code dry?',
  '  ',
  '**PR Comments / Feedback**  ',
  '- /pr-comments PR-URL',
  'Some prose that is not a prompt',
  '-',
].join('\n');

describe('parsePrompts', () => {
  it('reads each bullet as a prompt under the bold heading above it', () => {
    expect(parsePrompts(NOTE)).toEqual([
      { section: '', text: 'loose prompt' },
      { section: 'Reviews', text: '/code-review - PROJ-XXX - go/no-go' },
      { section: 'Reviews', text: 'Is this code dry?' },
      { section: 'PR Comments / Feedback', text: '/pr-comments PR-URL' },
    ]);
  });

  it('reads the note from disk on every call', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cw-prompts-')), 'prompts.md');
    writeFileSync(file, '**A**\n- one');
    expect(readPrompts(file)).toEqual([{ section: 'A', text: 'one' }]);
    writeFileSync(file, '**A**\n- two');
    expect(readPrompts(file)).toEqual([{ section: 'A', text: 'two' }]);
  });

  it('throws, naming the file, when it cannot be read', () => {
    expect(() => readPrompts('/nonexistent/prompts.md')).toThrow('/nonexistent/prompts.md');
  });
});

describe('fillPrompt', () => {
  const text = '/code-review max PR-URL for PROJ-XXX, ask NAME';

  it('fills the PR url and ticket when known', () => {
    expect(fillPrompt(text, { prUrl: 'https://github.com/o/r/pull/1', ticket: 'PROJ-12' })).toBe(
      '/code-review max https://github.com/o/r/pull/1 for PROJ-12, ask NAME',
    );
  });

  it('leaves a placeholder alone when its value is unknown', () => {
    expect(fillPrompt(text, { prUrl: null, ticket: 'PROJ-12' })).toBe('/code-review max PR-URL for PROJ-12, ask NAME');
    expect(fillPrompt(text, { prUrl: null, ticket: null })).toBe(text);
  });

  it('only replaces standalone placeholders and inserts values literally', () => {
    expect(fillPrompt('PR-URL-1 and PR-URL-2', { prUrl: 'u', ticket: null })).toBe('PR-URL-1 and PR-URL-2');
    expect(fillPrompt('see PR-URL', { prUrl: 'https://x/$&', ticket: null })).toBe('see https://x/$&');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run helper/test/prompts.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Add the type**

In `shared/protocol.ts`, after `WorkspaceStatus`:

```ts
/** One reusable prompt from the vault note, under the bold heading above it. */
export interface Prompt {
  section: string;
  text: string;
}
```

- [ ] **Step 4: Implement `shared/prompts.ts`**

```ts
// Used by the extension bundle — keep this free of Node imports.

export interface PromptValues {
  prUrl: string | null;
  ticket: string | null;
}

/** Fills standalone `PR-URL` and `PROJ-XXX` when known; every other placeholder is left for the user to edit. */
export function fillPrompt(text: string, { prUrl, ticket }: PromptValues): string {
  let filled = text;
  if (prUrl) filled = filled.replace(/PR-URL(?![\w-])/g, () => prUrl);
  if (ticket) filled = filled.replace(/PROJ-XXX(?![\w-])/g, () => ticket);
  return filled;
}
```

- [ ] **Step 5: Implement `helper/src/prompts.ts`**

```ts
import { readFileSync } from 'node:fs';
import type { Prompt } from '../../shared/protocol';

const HEADING = /^\*\*(.+?)\*\*$/;
const BULLET = /^\s*-\s+(.*\S)\s*$/;

/** Each `**Heading**` line starts a section; each `- ` bullet under it is one prompt. */
export function parsePrompts(markdown: string): Prompt[] {
  const prompts: Prompt[] = [];
  let section = '';
  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.trim().match(HEADING);
    if (heading) section = heading[1].trim();
    else {
      const bullet = line.match(BULLET);
      if (bullet) prompts.push({ section, text: bullet[1] });
    }
  }
  return prompts;
}

/** Read on every request so edits in Obsidian show up without restarting the helper. */
export function readPrompts(file: string): Prompt[] {
  try {
    return parsePrompts(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npx vitest run helper/test/prompts.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add shared/protocol.ts shared/prompts.ts helper/src/prompts.ts helper/test/prompts.test.ts
git commit -m "feat: parse reusable prompts from the vault and fill PR placeholders"
```

---

### Task 4: Review requests from `gh`

**Files:**
- Modify: `shared/protocol.ts`
- Create: `helper/src/reviews.ts`
- Test: `helper/test/reviews.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `helper/test/reviews.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseReviewRequests, ReviewsPoller, ticketFromTitle } from '../src/reviews';

const pr = (number: number, title: string, updatedAt: string) => ({
  author: { login: 'drew', is_bot: false },
  isDraft: number === 2,
  number,
  repository: { name: 'app', nameWithOwner: 'acme/app' },
  title,
  updatedAt,
  url: `https://github.com/acme/app/pull/${number}`,
});
const GH = JSON.stringify([pr(1, 'PROJ-10 - Fix it', '2026-10-01T00:00:00Z'), pr(2, 'Tidy up', '2026-10-02T00:00:00Z')]);

describe('ticketFromTitle', () => {
  it('prefers a key outside brackets, since a bracketed key names the parent', () => {
    expect(ticketFromTitle('[PROJ-1731] PROJ-1737 - Sync cache')).toBe('PROJ-1737');
    expect(ticketFromTitle('[PROJ-1731] Sync cache')).toBe('PROJ-1731');
    expect(ticketFromTitle('OPS-88: fix')).toBe('OPS-88');
    expect(ticketFromTitle('Bump deps')).toBeNull();
  });
});

describe('parseReviewRequests', () => {
  it('maps gh search output, most recently updated first', () => {
    expect(parseReviewRequests(GH)).toEqual([
      { repo: 'acme/app', number: 2, title: 'Tidy up', url: 'https://github.com/acme/app/pull/2', author: 'drew', isDraft: true, updatedAt: '2026-10-02T00:00:00Z', ticket: null },
      { repo: 'acme/app', number: 1, title: 'PROJ-10 - Fix it', url: 'https://github.com/acme/app/pull/1', author: 'drew', isDraft: false, updatedAt: '2026-10-01T00:00:00Z', ticket: 'PROJ-10' },
    ]);
  });

  it('rejects output that is not a list', () => {
    expect(() => parseReviewRequests('{"message":"Bad credentials"}')).toThrow();
  });
});

describe('ReviewsPoller', () => {
  it('starts empty, then holds the fetched list and notifies', async () => {
    const poller = new ReviewsPoller(async () => GH);
    let changes = 0;
    poller.onChange(() => changes++);
    expect(poller.state()).toEqual({ items: [], error: null, fetchedAt: null });
    await poller.refresh();
    expect(poller.state().items.map((r) => r.number)).toEqual([2, 1]);
    expect(poller.state().error).toBeNull();
    expect(poller.state().fetchedAt).not.toBeNull();
    expect(changes).toBe(1);
  });

  it('keeps the last good list and reports the error when a fetch fails', async () => {
    let fail = false;
    const poller = new ReviewsPoller(async () => {
      if (fail) throw new Error('gh: authentication required');
      return GH;
    });
    await poller.refresh();
    fail = true;
    await poller.refresh();
    expect(poller.state().items).toHaveLength(2);
    expect(poller.state().error).toBe('gh: authentication required');
  });

  it('reports unparseable output as an error', async () => {
    const poller = new ReviewsPoller(async () => 'not json');
    await poller.refresh();
    expect(poller.state().error).toMatch(/JSON/);
  });

  it('shares a fetch already in flight', async () => {
    let calls = 0;
    const poller = new ReviewsPoller(async () => {
      calls++;
      return GH;
    });
    await Promise.all([poller.refresh(), poller.refresh()]);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run helper/test/reviews.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Add the types**

In `shared/protocol.ts`, after `Prompt`:

```ts
/** An open PR that requests the user's review. */
export interface ReviewRequest {
  /** `owner/name`. */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
  ticket: string | null;
}

export interface ReviewsState {
  items: ReviewRequest[];
  /** Why the last fetch failed; `items` then still holds the last good list. */
  error: string | null;
  fetchedAt: string | null;
}
```

- [ ] **Step 4: Implement `helper/src/reviews.ts`**

```ts
import type { ReviewRequest, ReviewsState } from '../../shared/protocol';

export const GH_REVIEW_REQUESTS =
  'gh search prs --review-requested=@me --state=open --json number,title,url,repository,author,isDraft,updatedAt --limit 50';

const TICKET = /[A-Z][A-Z0-9]*-\d+/;

interface GhPullRequest {
  number: number;
  title: string;
  url: string;
  repository: { nameWithOwner: string };
  author: { login: string };
  isDraft: boolean;
  updatedAt: string;
}

/** A bracketed key in a PR title names its parent, so a key outside brackets wins. */
export function ticketFromTitle(title: string): string | null {
  return (title.replace(/\[[^\]]*\]/g, ' ').match(TICKET) ?? title.match(TICKET))?.[0] ?? null;
}

export function parseReviewRequests(json: string): ReviewRequest[] {
  const raw = JSON.parse(json) as unknown;
  if (!Array.isArray(raw)) throw new Error(`unexpected gh output: ${json.slice(0, 200)}`);
  return (raw as GhPullRequest[])
    .map((pr) => ({
      repo: pr.repository.nameWithOwner,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author.login,
      isDraft: pr.isDraft,
      updatedAt: pr.updatedAt,
      ticket: ticketFromTitle(pr.title),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Keeps the review-request list fresh. A failed fetch keeps the last good list and records why. */
export class ReviewsPoller {
  private current: ReviewsState = { items: [], error: null, fetchedAt: null };
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly fetchJson: () => Promise<string>) {}

  state(): ReviewsState {
    return { ...this.current, items: [...this.current.items] };
  }

  refresh(): Promise<void> {
    this.inFlight ??= this.fetchJson()
      .then(parseReviewRequests)
      .then(
        (items) => {
          this.current = { items, error: null, fetchedAt: new Date().toISOString() };
        },
        (error: unknown) => {
          this.current = { ...this.current, error: error instanceof Error ? error.message : String(error) };
        },
      )
      .finally(() => {
        this.inFlight = null;
        for (const listener of this.listeners) listener();
      });
    return this.inFlight;
  }

  start(intervalMs: number): void {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run helper/test/reviews.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add shared/protocol.ts helper/src/reviews.ts helper/test/reviews.test.ts
git commit -m "feat(helper): poll gh for PRs requesting review"
```

---

### Task 5: Config and PR workspace defaults

**Files:**
- Modify: `helper/src/config.ts`, `helper/src/api.ts` (move `isDirectory`), `scripts/setup.ts:22-24`
- Create: `helper/src/pr-workspace.ts`
- Test: `helper/test/pr-workspace.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `helper/test/pr-workspace.test.ts`:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ReviewRequest } from '../../shared/protocol';
import { isPullRequestUrl, prWorkspace } from '../src/pr-workspace';

const URL = 'https://github.com/acme/app/pull/482';
const review: ReviewRequest = {
  repo: 'acme/app',
  number: 482,
  title: 'PROJ-9 - x',
  url: URL,
  author: 'drew',
  isDraft: false,
  updatedAt: '2026-10-01T00:00:00Z',
  ticket: 'PROJ-9',
};
const defaultCwd = mkdtempSync(join(tmpdir(), 'cw-default-'));
const repoDir = mkdtempSync(join(tmpdir(), 'cw-repo-'));

describe('isPullRequestUrl', () => {
  it('accepts only github.com pull request urls', () => {
    expect(isPullRequestUrl(URL)).toBe(true);
    expect(isPullRequestUrl(`${URL}/files`)).toBe(false);
    expect(isPullRequestUrl('https://evil.example/o/r/pull/1')).toBe(false);
    expect(isPullRequestUrl('https://github.com/o/r/issues/1')).toBe(false);
  });
});

describe('prWorkspace', () => {
  it('names the workspace repo#number, opens the PR, and takes the ticket from the review list', () => {
    expect(prWorkspace(URL, { reviews: [review], repoDirs: {}, defaultCwd })).toEqual({
      name: 'app#482',
      ticket: 'PROJ-9',
      cwd: defaultCwd,
      url: URL,
      pr: URL,
    });
  });

  it('starts in the mapped repo directory when it exists', () => {
    expect(prWorkspace(URL, { reviews: [], repoDirs: { 'acme/app': repoDir }, defaultCwd }).cwd).toBe(repoDir);
    expect(prWorkspace(URL, { reviews: [], repoDirs: { 'acme/app': join(repoDir, 'gone') }, defaultCwd }).cwd).toBe(defaultCwd);
  });

  it('has no ticket for a PR outside the review list', () => {
    expect(prWorkspace(URL, { reviews: [], repoDirs: {}, defaultCwd }).ticket).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run helper/test/pr-workspace.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Extend config**

Replace the body of `helper/src/config.ts` from `export interface HelperConfig` down:

```ts
export interface HelperConfig {
  extensionId: string;
  /** Where new workspaces start when no directory is given. */
  defaultCwd: string;
  /** The Obsidian note holding reusable prompts. */
  promptsFile: string;
  /** `owner/name` to the directory PR workspaces for that repo start in. */
  repoDirs: Record<string, string>;
}

const DEFAULT_PROMPTS_FILE = '~/Documents/Websites/obsidian-vault/Patterns/Most Used Prompts.md';

export function loadConfig(): HelperConfig {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'config.json'), 'utf8')) as Partial<HelperConfig>;
  if (!raw.extensionId) throw new Error(`${join(DATA_DIR, 'config.json')} has no extensionId; run npm run setup`);
  return {
    extensionId: raw.extensionId,
    defaultCwd: raw.defaultCwd ?? homedir(),
    promptsFile: expandHome(raw.promptsFile ?? DEFAULT_PROMPTS_FILE),
    repoDirs: Object.fromEntries(Object.entries(raw.repoDirs ?? {}).map(([repo, dir]) => [repo, expandHome(dir)])),
  };
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
```

Change its first import to `import { readFileSync, statSync } from 'node:fs';`.

In `helper/src/api.ts`, delete the local `isDirectory` function, drop `statSync` from the `node:fs` import (remove the import line entirely), and add `import { isDirectory } from './config';`.

- [ ] **Step 4: Implement `helper/src/pr-workspace.ts`**

```ts
import type { ReviewRequest } from '../../shared/protocol';
import { isDirectory } from './config';
import type { NewWorkspace } from './workspace-store';

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
```

- [ ] **Step 5: Keep unmanaged config fields in setup**

In `scripts/setup.ts`, change line 22's cast to `as Record<string, unknown> & { defaultCwd?: string }` and line 24 to:

```ts
writeFileSync(configFile, `${JSON.stringify({ ...existing, extensionId, defaultCwd }, null, 2)}\n`);
```

- [ ] **Step 6: Run the suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add helper/src/config.ts helper/src/api.ts helper/src/pr-workspace.ts helper/test/pr-workspace.test.ts scripts/setup.ts
git commit -m "feat(helper): prompts file and per-repo directories in config"
```

---

### Task 6: Control channel

**Files:**
- Modify: `shared/protocol.ts`, `helper/src/control.ts`, `helper/test/harness.ts`
- Test: `helper/test/control.test.ts`

- [ ] **Step 1: Give the harness fakes**

Replace `helper/test/harness.ts` from `export interface Harness` through the end of `startHarness`:

```ts
export interface Harness {
  server: RunningServer;
  store: WorkspaceStore;
  sessions: SessionManager;
  control: ControlHub;
  defaultCwd: string;
  statuses: Record<string, WorkspaceStatus>;
  /** What the fake review poller reports; tests push into it. */
  reviews: ReviewRequest[];
  reviewRefreshes: number;
  prompts: Prompt[];
  /** When set, reading prompts fails with this message. */
  promptsError: string | null;
  repoDirs: Record<string, string>;
  url(path: string): string;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'cw-harness-'));
  const defaultCwd = mkdtempSync(join(tmpdir(), 'cw-cwd-'));
  const store = new WorkspaceStore(join(dir, 'workspaces.json'));
  const sessions = new SessionManager(10_000);
  const fakes = {
    statuses: {} as Record<string, WorkspaceStatus>,
    reviews: [] as ReviewRequest[],
    reviewRefreshes: 0,
    prompts: [] as Prompt[],
    promptsError: null as string | null,
    repoDirs: {} as Record<string, string>,
  };
  const reviews = {
    state: () => ({ items: fakes.reviews, error: null, fetchedAt: null }),
    refresh: async () => {
      fakes.reviewRefreshes++;
    },
  };
  const prompts = () => {
    if (fakes.promptsError) throw new Error(fakes.promptsError);
    return fakes.prompts;
  };
  const statuses = () => fakes.statuses;
  const control = new ControlHub({ store, sessions, defaultCwd, statuses, reviews, prompts, repoDirs: fakes.repoDirs });
  const auth = { token: TOKEN, allowedOrigins: [ORIGIN] };
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    auth,
    sessions,
    control,
    api: createApi({ auth, store, control, sessions, defaultCwd, statuses, reviews, repoDirs: fakes.repoDirs }),
  });
  return Object.assign(fakes, {
    server,
    store,
    sessions,
    control,
    defaultCwd,
    url: (path: string) => `http://127.0.0.1:${server.port}${path}`,
    close: async () => {
      await server.close();
      sessions.killAll();
    },
  });
}
```

Change the protocol import line to:

```ts
import { PROTOCOL, TOKEN_PROTOCOL_PREFIX, type ControlToClient, type Prompt, type ReviewRequest, type WorkspaceStatus } from '../../shared/protocol';
```

(`createApi` gets `reviews` and `repoDirs` in Task 7; until then `npm run typecheck` reports those two extra properties, which is expected.)

- [ ] **Step 2: Write the failing tests**

In `helper/test/control.test.ts`, change the first test's expectation to include reviews:

```ts
    expect(messages[0]).toEqual({
      type: 'state',
      workspaces: [expect.objectContaining({ id: a.id })],
      statuses: { [a.id]: 'needs_input' },
      reviews: { items: [], error: null, fetchedAt: null },
    });
```

Add these imports at the top:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReviewRequest } from '../../shared/protocol';
```

Add below `lastState`:

```ts
const PR = 'https://github.com/acme/app/pull/482';
const review: ReviewRequest = {
  repo: 'acme/app',
  number: 482,
  title: 'PROJ-9 - x',
  url: PR,
  author: 'drew',
  isDraft: false,
  updatedAt: '2026-10-01T00:00:00Z',
  ticket: 'PROJ-9',
};
```

Append inside `describe('control channel', ...)`:

```ts
  it('creates a PR workspace in its repo directory with the prompt, and opens it', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'cw-repo-'));
    h.reviews.push(review);
    h.repoDirs['acme/app'] = repoDir;
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'app#482', windowId: null, pr: PR, prompt: `  /code-review ${PR}  ` }));
    await waitFor(() => messages.some((m) => m.type === 'open'));
    expect(h.store.list()[0]).toMatchObject({ name: 'app#482', ticket: 'PROJ-9', cwd: repoDir, url: PR, pr: PR, prompt: `/code-review ${PR}` });
    ws.close();
  });

  it('focuses the existing workspace for a PR instead of creating another', async () => {
    const existing = h.store.create({ name: 'mine', cwd: h.defaultCwd, pr: PR });
    const { ws, messages } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'app#482', windowId: null, pr: PR, prompt: 'x' }));
    await waitFor(() => messages.some((m) => m.type === 'focus' && m.id === existing.id));
    expect(h.store.list()).toHaveLength(1);
    ws.close();
  });

  it('creates a prompt-only workspace in the default directory', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'triage', windowId: null, prompt: 'Dig into this prod issue' }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0]).toMatchObject({ name: 'triage', cwd: h.defaultCwd, pr: null, prompt: 'Dig into this prod issue' });
    ws.close();
  });

  it('ignores a create with a non-PR url or an overlong prompt', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'create', name: 'a', windowId: null, pr: 'https://evil.example/o/r/pull/1' }));
    ws.send(JSON.stringify({ type: 'create', name: 'b', windowId: null, prompt: 'x'.repeat(8001) }));
    ws.send(JSON.stringify({ type: 'create', name: 'c', windowId: null }));
    await waitFor(() => h.store.list().length === 1);
    expect(h.store.list()[0].name).toBe('c');
    ws.close();
  });

  it('answers listPrompts to the asking client only, reporting read errors', async () => {
    h.prompts.push({ section: 'Reviews', text: '/code-review PR-URL' });
    const asker = connectControl(h);
    const other = connectControl(h);
    await Promise.all([opened(asker.ws), opened(other.ws)]);
    asker.ws.send(JSON.stringify({ type: 'listPrompts' }));
    await waitFor(() => asker.messages.some((m) => m.type === 'prompts'));
    expect(asker.messages.find((m) => m.type === 'prompts')).toEqual({ type: 'prompts', prompts: [{ section: 'Reviews', text: '/code-review PR-URL' }], error: null });

    h.promptsError = 'cannot read /x.md: ENOENT';
    asker.ws.send(JSON.stringify({ type: 'listPrompts' }));
    await waitFor(() => asker.messages.filter((m) => m.type === 'prompts').length === 2);
    expect(asker.messages.filter((m) => m.type === 'prompts')[1]).toEqual({ type: 'prompts', prompts: [], error: 'cannot read /x.md: ENOENT' });
    expect(other.messages.some((m) => m.type === 'prompts')).toBe(false);
    asker.ws.close();
    other.ws.close();
  });

  it('refreshes review requests on request', async () => {
    const { ws } = connectControl(h);
    await opened(ws);
    ws.send(JSON.stringify({ type: 'refreshReviews' }));
    await waitFor(() => h.reviewRefreshes === 1);
    ws.close();
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run helper/test/control.test.ts`
Expected: the state test and the six new tests FAIL.

- [ ] **Step 4: Extend the control protocol**

In `shared/protocol.ts`, replace `ControlToClient` and `ControlToHelper`:

```ts
export type ControlToClient =
  | { type: 'state'; workspaces: Workspace[]; statuses: Record<string, WorkspaceStatus>; reviews: ReviewsState }
  | { type: 'open'; id: string }
  | { type: 'focus'; id: string }
  /** The workspace's claude used Claude in Chrome at `at` (epoch ms). */
  | { type: 'browser'; id: string; at: number }
  /** Reply to `listPrompts`, sent only to the client that asked. */
  | { type: 'prompts'; prompts: Prompt[]; error: string | null };

export type ControlToHelper =
  | { type: 'pair'; id: string; windowId: number }
  | { type: 'unpair'; windowId: number }
  | { type: 'tabs'; windowId: number; urls: string[] }
  /** With `pr`, focuses the PR's existing workspace instead of creating another. */
  | { type: 'create'; name: string; windowId: number | null; pr?: string; prompt?: string }
  | { type: 'remove'; id: string }
  | { type: 'rename'; id: string; name: string }
  | { type: 'listPrompts' }
  | { type: 'refreshReviews' };
```

- [ ] **Step 5: Implement in `helper/src/control.ts`**

Replace the imports and `ControlHubOptions`:

```ts
import type { WebSocket } from 'ws';
import { MAX_PROMPT_LENGTH, type ControlToClient, type ControlToHelper, type Prompt, type ReviewsState, type WorkspaceStatus } from '../../shared/protocol';
import { isPullRequestUrl, prWorkspace } from './pr-workspace';
import type { SessionManager } from './session';
import type { WorkspaceStore } from './workspace-store';

export interface ReviewSource {
  state(): ReviewsState;
  refresh(): Promise<void>;
}

export interface ControlHubOptions {
  store: WorkspaceStore;
  sessions: SessionManager;
  defaultCwd: string;
  statuses: () => Record<string, WorkspaceStatus>;
  reviews: ReviewSource;
  /** Throws when the prompts file cannot be read. */
  prompts: () => Prompt[];
  repoDirs: Record<string, string>;
}
```

In `add`, change `if (isControlToHelper(message)) this.handle(message);` to `if (isControlToHelper(message)) this.handle(message, ws);`.

Replace `state()`:

```ts
  private state(): ControlToClient {
    const { store, statuses, reviews } = this.options;
    return { type: 'state', workspaces: store.list(), statuses: statuses(), reviews: reviews.state() };
  }
```

Change the `handle` signature to `private handle(message: ControlToHelper, ws: WebSocket): void {` and replace its `create` case, adding two cases after `remove`:

```ts
      case 'create': {
        const existing = message.pr ? store.findByPr(message.pr) : undefined;
        if (existing) {
          this.send({ type: 'focus', id: existing.id });
          break;
        }
        const { defaultCwd, repoDirs, reviews } = this.options;
        const base = message.pr ? prWorkspace(message.pr, { reviews: reviews.state().items, repoDirs, defaultCwd }) : { cwd: defaultCwd };
        const workspace = store.create({ ...base, name: message.name.trim(), prompt: message.prompt?.trim() || null });
        if (message.windowId === null) this.send({ type: 'open', id: workspace.id });
        else store.pairWindow(workspace.id, message.windowId);
        break;
      }
```

```ts
      case 'listPrompts':
        this.sendTo(ws, this.prompts());
        break;
      case 'refreshReviews':
        void this.options.reviews.refresh();
        break;
```

Add after `state()`:

```ts
  private prompts(): ControlToClient {
    try {
      return { type: 'prompts', prompts: this.options.prompts(), error: null };
    } catch (error) {
      return { type: 'prompts', prompts: [], error: error instanceof Error ? error.message : String(error) };
    }
  }
```

In `isControlToHelper`, replace the `create` case and add the two new types:

```ts
    case 'create':
      return (
        isWorkspaceName(m.name) &&
        (m.windowId === null || isWindowId(m.windowId)) &&
        (m.pr === undefined || (typeof m.pr === 'string' && isPullRequestUrl(m.pr))) &&
        (m.prompt === undefined || (typeof m.prompt === 'string' && m.prompt.length <= MAX_PROMPT_LENGTH))
      );
    case 'listPrompts':
    case 'refreshReviews':
      return true;
```

- [ ] **Step 6: Run the control tests**

Run: `npx vitest run helper/test/control.test.ts`
Expected: PASS. (`npm run typecheck` still flags `createApi`'s extra properties until Task 7.)

- [ ] **Step 7: Commit**

```bash
git add shared/protocol.ts helper/src/control.ts helper/test/harness.ts helper/test/control.test.ts
git commit -m "feat(helper): create PR and prompt workspaces over the control channel"
```

---

### Task 7: HTTP API

**Files:**
- Modify: `helper/src/api.ts`
- Test: `helper/test/api.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside `describe('HTTP API', ...)` in `helper/test/api.test.ts`:

```ts
  it('creates a PR workspace with a prompt, and focuses it on a repeat', async () => {
    const pr = 'https://github.com/acme/app/pull/482';
    const first = await call('/workspaces', { method: 'POST', body: { pr, prompt: '/code-review' } });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ created: true, workspace: { name: 'app#482', pr, url: pr, prompt: '/code-review', cwd: h.defaultCwd } });

    const again = await call('/workspaces', { method: 'POST', body: { pr } });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false });
    expect(h.store.list()).toHaveLength(1);
  });

  it('rejects a non-PR url and an overlong prompt', async () => {
    expect((await call('/workspaces', { method: 'POST', body: { pr: 'https://github.com/o/r/issues/1' } })).status).toBe(400);
    expect((await call('/workspaces', { method: 'POST', body: { name: 'x', prompt: 'x'.repeat(8001) } })).status).toBe(400);
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run helper/test/api.test.ts`
Expected: the two new tests FAIL.

- [ ] **Step 3: Implement**

In `helper/src/api.ts`, update the imports:

```ts
import { MAX_PROMPT_LENGTH, type WorkspaceStatus } from '../../shared/protocol';
import type { AuthPolicy } from './auth';
import { isDirectory } from './config';
import type { ControlHub, ReviewSource } from './control';
import { isPullRequestUrl, prWorkspace } from './pr-workspace';
```

Add to `ApiOptions`:

```ts
  reviews: Pick<ReviewSource, 'state'>;
  repoDirs: Record<string, string>;
```

In `handle`, replace the `POST /workspaces` block:

```ts
  if (pathname === '/workspaces' && req.method === 'POST') {
    const input = parseCreate(await readJson(req), options);
    // A PR workspace is matched by PR only: a review of a ticket's PR is separate from working on the ticket.
    const existing = input.pr ? store.findByPr(input.pr) : input.ticket ? store.findByTicket(input.ticket) : undefined;
    if (existing) {
      const delivered = control.send({ type: 'focus', id: existing.id });
      return { status: 200, body: { workspace: existing, created: false, delivered } };
    }
    const workspace = store.create(input);
    const delivered = control.send({ type: 'open', id: workspace.id });
    return { status: 201, body: { workspace, created: true, delivered } };
  }
```

Replace `parseCreate`:

```ts
function parseCreate(body: unknown, { defaultCwd, repoDirs, reviews }: ApiOptions) {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'expected a JSON object');
  const { name, ticket, cwd, url, pr, prompt } = body as Record<string, unknown>;
  const promptValue = optionalString(prompt, 'prompt', MAX_PROMPT_LENGTH);

  const prValue = optionalString(pr, 'pr', 2048);
  if (prValue) {
    if (!isPullRequestUrl(prValue)) throw new HttpError(400, 'pr must be a GitHub pull request url');
    const base = prWorkspace(prValue, { reviews: reviews.state().items, repoDirs, defaultCwd });
    return { ...base, name: optionalString(name, 'name', 80) ?? base.name, prompt: promptValue };
  }

  const ticketValue = optionalString(ticket, 'ticket', 64);
  const nameValue = optionalString(name, 'name', 80) ?? ticketValue;
  if (!nameValue) throw new HttpError(400, 'name or ticket is required');

  const cwdValue = optionalString(cwd, 'cwd', 1024) ?? defaultCwd;
  if (!isAbsolute(cwdValue) || !isDirectory(cwdValue)) throw new HttpError(400, `cwd is not an existing absolute directory: ${cwdValue}`);

  const urlValue = optionalString(url, 'url', 2048);
  if (urlValue && !/^https?:\/\//i.test(urlValue)) throw new HttpError(400, 'url must be http(s)');

  return { name: nameValue, ticket: ticketValue, cwd: cwdValue, url: urlValue, pr: null, prompt: promptValue };
}
```

- [ ] **Step 4: Run the suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS except `helper/src/main.ts`, which typecheck flags for the missing `ControlHub`/`createApi` options. That is fixed in Task 8.

- [ ] **Step 5: Commit**

```bash
git add helper/src/api.ts helper/test/api.test.ts
git commit -m "feat(helper): accept pr and prompt on POST /workspaces"
```

---

### Task 8: Wire the helper

**Files:**
- Modify: `helper/src/main.ts`

- [ ] **Step 1: Wire the poller, prompts, and config**

In `helper/src/main.ts`, add imports:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPrompts } from './prompts';
import { GH_REVIEW_REQUESTS, ReviewsPoller } from './reviews';
```

After the `statuses` declaration, add:

```ts
const REVIEW_POLL_MS = 5 * 60_000;
const execFileAsync = promisify(execFile);
// launchd's PATH lacks Homebrew, so gh runs through a login shell.
const reviews = new ReviewsPoller(
  async () => (await execFileAsync(shell, ['-l', '-c', GH_REVIEW_REQUESTS], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })).stdout,
);
const prompts = () => readPrompts(config.promptsFile);
```

Replace the `ControlHub` construction:

```ts
const control = new ControlHub({ store, sessions, defaultCwd: config.defaultCwd, statuses, reviews, prompts, repoDirs: config.repoDirs });
reviews.onChange(() => control.broadcastState());
reviews.start(REVIEW_POLL_MS);
```

Replace the `api:` line:

```ts
  api: createApi({ auth, store, control, sessions, defaultCwd: config.defaultCwd, statuses, reviews, repoDirs: config.repoDirs }),
```

In `shutdown`, add `reviews.stop();` after `stopWatching();`.

- [ ] **Step 2: Run the suite and typecheck**

Run: `npx vitest run && npm run typecheck`
Expected: PASS, no type errors in `helper/` or `shared/`. `extension/src/panel.ts` may report nothing yet since it only reads `state` fields that still exist.

- [ ] **Step 3: Smoke-test against a second helper**

```bash
CW_PORT=4179 npx tsx helper/src/main.ts > "$TMPDIR/cw-smoke.log" 2>&1 &
PID=$!
sleep 8
printf 'header = "Authorization: Bearer %s"\n' "$(<$HOME/.chrome-workspaces/token)" | curl -fsS --config - http://127.0.0.1:4179/workspaces | head -c 300
kill $PID
cat "$TMPDIR/cw-smoke.log"
```

Expected: JSON with `workspaces` and `statuses`, and a log line `chrome-workspaces helper on 127.0.0.1:4179`. This helper shares the real data dir, so make no create calls against it. Review requests travel only on the control channel; the panel check in Task 10 covers them.

- [ ] **Step 4: Commit**

```bash
git add helper/src/main.ts
git commit -m "feat(helper): poll review requests and serve vault prompts"
```

---

### Task 9: Panel - review requests, `+` menu, prompt picker

**Files:**
- Create: `extension/src/launcher.ts`
- Modify: `extension/panel.html`, `extension/panel.css`, `extension/src/panel.ts`

The extension has no unit test setup; this task is verified by typecheck, build, and the manual run in Task 10.

- [ ] **Step 1: Markup**

In `extension/panel.html`, replace the `<button id="new" ...>` line with:

```html
      <div id="new-menu" hidden>
        <button id="new-blank">Blank</button>
        <button id="new-prompt">From prompt…</button>
      </div>
      <button id="new" title="New workspace">+</button>
      <section id="reviews">
        <div id="reviews-header">
          <button id="reviews-toggle" title="Collapse review requests">▾</button>
          <span id="reviews-title">Review requests</span>
          <button id="reviews-refresh" title="Refresh review requests">↻</button>
        </div>
        <div id="reviews-error" hidden></div>
        <ul id="reviews-list"></ul>
      </section>
```

Inside `<main id="main">`, after the `#picker` section, add:

```html
      <section id="launch" hidden>
        <div id="launch-choose">
          <h2 id="launch-title"></h2>
          <input id="launch-filter" placeholder="Filter prompts" autocomplete="off" />
          <div id="launch-error" hidden></div>
          <div id="launch-prompts"></div>
        </div>
        <form id="launch-edit" hidden>
          <input id="launch-name" placeholder="Workspace name" maxlength="80" autocomplete="off" required />
          <textarea id="launch-text" maxlength="8000" required></textarea>
          <div id="launch-actions">
            <button type="button" id="launch-back">Back</button>
            <button type="submit" id="launch-start">Start</button>
          </div>
        </form>
      </section>
```

- [ ] **Step 2: Styles**

Append to `extension/panel.css`:

```css
/* New-workspace menu */

#new-menu {
  display: flex;
  flex-direction: column;
  margin: 0 6px 4px;
}

#new-menu[hidden] {
  display: none;
}

#new-menu button,
#reviews-header button,
#launch-actions button,
.prompt {
  background: none;
  border: 0;
  cursor: pointer;
  text-align: left;
  border-radius: 4px;
}

#new-menu button {
  padding: 4px 6px;
}

#new-menu button:hover,
#reviews-header button:hover {
  background: var(--active);
}

/* Review requests */

#reviews {
  flex: none;
  max-height: 40%;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border);
}

#reviews-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px;
  color: var(--muted);
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.06em;
}

#reviews-title {
  flex: 1;
}

#reviews-header button {
  color: var(--muted);
  padding: 2px 6px;
}

#reviews.collapsed #reviews-list,
#reviews.collapsed #reviews-error {
  display: none;
}

#reviews.collapsed #reviews-toggle {
  transform: rotate(-90deg);
}

#reviews-error {
  margin: 0 6px 4px;
  color: var(--needs-input);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

#reviews-list {
  list-style: none;
  margin: 0;
  padding: 0 4px 6px;
  overflow-y: auto;
}

.review {
  display: flex;
  flex-direction: column;
  padding: 4px 6px;
  border-radius: 5px;
  cursor: pointer;
}

.review:hover {
  background: #22262d;
}

.review .ref {
  display: flex;
  align-items: center;
  gap: 4px;
}

.review .has-workspace {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}

.review .draft {
  color: var(--muted);
  font-size: 10px;
}

.review .title {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

body.collapsed #reviews,
body.collapsed #new-menu {
  display: none;
}

/* Launch view */

#launch {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

#launch h2 {
  font-size: 13px;
  font-weight: 600;
  margin: 0 0 10px;
}

#launch-filter,
#launch-name,
#launch-text {
  width: 100%;
  box-sizing: border-box;
  background: var(--bg);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 6px;
  margin-bottom: 8px;
  font: inherit;
}

#launch-text {
  min-height: 160px;
  resize: vertical;
}

#launch-error {
  color: var(--needs-input);
  margin-bottom: 8px;
}

.prompt-group h3 {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 10px 0 4px;
}

.prompt {
  display: block;
  width: 100%;
  padding: 5px 8px;
  margin-bottom: 2px;
  background: #22262d;
  border: 1px solid var(--border);
  border-radius: 5px;
}

.prompt:hover {
  border-color: var(--accent);
}

#launch-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

#launch-actions button {
  padding: 5px 12px;
  border: 1px solid var(--border);
}

#launch-start {
  background: var(--accent);
  color: #fff;
}
```

- [ ] **Step 3: Implement `extension/src/launcher.ts`**

```ts
import { fillPrompt } from '../../shared/prompts';
import type { ControlToHelper, Prompt, ReviewRequest, ReviewsState, Workspace } from '../../shared/protocol';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface LauncherOptions {
  send(message: ControlToHelper): boolean;
  /** Called when the launch view opens or closes, so the panel can swap it with the terminal. */
  onToggle(): void;
  openWorkspace(workspace: Workspace): void;
}

export interface Launcher {
  readonly isOpen: boolean;
  /** Opens the prompt picker, for a review request or for a prompt alone. */
  show(review: ReviewRequest | null): void;
  renderReviews(state: ReviewsState, workspaces: readonly Workspace[]): void;
  setPrompts(prompts: Prompt[], error: string | null): void;
}

const repoName = (review: ReviewRequest) => review.repo.split('/')[1] ?? review.repo;
const ref = (review: ReviewRequest) => `${repoName(review)}#${review.number}`;

export function createLauncher({ send, onToggle, openWorkspace }: LauncherOptions): Launcher {
  const section = $<HTMLElement>('launch');
  const choose = $<HTMLDivElement>('launch-choose');
  const title = $<HTMLHeadingElement>('launch-title');
  const filter = $<HTMLInputElement>('launch-filter');
  const errorEl = $<HTMLDivElement>('launch-error');
  const promptsEl = $<HTMLDivElement>('launch-prompts');
  const editForm = $<HTMLFormElement>('launch-edit');
  const nameInput = $<HTMLInputElement>('launch-name');
  const textInput = $<HTMLTextAreaElement>('launch-text');
  const reviewsSection = $<HTMLElement>('reviews');
  const reviewsTitle = $<HTMLSpanElement>('reviews-title');
  const reviewsError = $<HTMLDivElement>('reviews-error');
  const reviewsList = $<HTMLUListElement>('reviews-list');

  let isOpen = false;
  let review: ReviewRequest | null = null;
  let prompts: Prompt[] = [];

  function show(target: ReviewRequest | null): void {
    review = target;
    isOpen = true;
    title.textContent = target ? `${ref(target)}: ${target.title}` : 'New workspace from a prompt';
    filter.value = '';
    choose.hidden = false;
    editForm.hidden = true;
    section.hidden = false;
    send({ type: 'listPrompts' });
    onToggle();
    filter.focus();
  }

  function close(): void {
    isOpen = false;
    section.hidden = true;
    onToggle();
  }

  function renderPrompts(): void {
    const query = filter.value.trim().toLowerCase();
    const groups = new Map<string, Prompt[]>();
    for (const prompt of prompts) {
      if (query && !`${prompt.section} ${prompt.text}`.toLowerCase().includes(query)) continue;
      groups.set(prompt.section, [...(groups.get(prompt.section) ?? []), prompt]);
    }
    promptsEl.replaceChildren(
      ...[...groups].map(([name, items]) => {
        const group = document.createElement('div');
        group.className = 'prompt-group';
        const heading = document.createElement('h3');
        heading.textContent = name || 'Prompts';
        group.append(
          heading,
          ...items.map((prompt) => {
            const button = document.createElement('button');
            button.className = 'prompt';
            button.textContent = prompt.text;
            button.addEventListener('click', () => edit(prompt));
            return button;
          }),
        );
        return group;
      }),
    );
  }

  function edit(prompt: Prompt): void {
    choose.hidden = true;
    editForm.hidden = false;
    nameInput.value = review ? ref(review) : '';
    textInput.value = fillPrompt(prompt.text, { prUrl: review?.url ?? null, ticket: review?.ticket ?? null });
    (review ? textInput : nameInput).focus();
  }

  filter.addEventListener('input', renderPrompts);

  $<HTMLButtonElement>('launch-back').addEventListener('click', () => {
    editForm.hidden = true;
    choose.hidden = false;
    filter.focus();
  });

  editForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = nameInput.value.trim();
    const prompt = textInput.value.trim();
    if (!name || !prompt) return;
    send({ type: 'create', name, windowId: null, prompt, ...(review ? { pr: review.url } : {}) });
    close();
  });

  section.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });

  $<HTMLButtonElement>('reviews-refresh').addEventListener('click', () => send({ type: 'refreshReviews' }));

  $<HTMLButtonElement>('reviews-toggle').addEventListener('click', () => {
    const collapsed = reviewsSection.classList.toggle('collapsed');
    void chrome.storage.local.set({ reviewsCollapsed: collapsed });
  });

  void chrome.storage.local.get('reviewsCollapsed').then(({ reviewsCollapsed }) => {
    reviewsSection.classList.toggle('collapsed', reviewsCollapsed === true);
  });

  function renderReviews(state: ReviewsState, workspaces: readonly Workspace[]): void {
    reviewsTitle.textContent = `Review requests (${state.items.length})`;
    reviewsError.hidden = state.error === null;
    reviewsError.textContent = state.error?.split('\n')[0] ?? '';
    reviewsError.title = state.error ?? '';
    reviewsList.replaceChildren(
      ...state.items.map((item) => {
        const existing = workspaces.find((ws) => ws.pr === item.url);
        const row = document.createElement('li');
        row.className = 'review';
        row.title = `${item.title}\n${item.repo} by ${item.author}${existing ? `\nWorkspace: ${existing.name}` : ''}`;

        const head = document.createElement('span');
        head.className = 'ref';
        head.append(ref(item));
        if (item.isDraft) {
          const draft = document.createElement('span');
          draft.className = 'draft';
          draft.textContent = 'draft';
          head.append(draft);
        }
        if (existing) {
          const dot = document.createElement('span');
          dot.className = 'has-workspace';
          head.append(dot);
        }

        const itemTitle = document.createElement('span');
        itemTitle.className = 'title';
        itemTitle.textContent = item.title;

        row.append(head, itemTitle);
        row.addEventListener('click', () => (existing ? openWorkspace(existing) : show(item)));
        return row;
      }),
    );
  }

  return {
    get isOpen() {
      return isOpen;
    },
    show,
    renderReviews,
    setPrompts(next, error) {
      prompts = next;
      errorEl.hidden = error === null;
      errorEl.textContent = error ? `Could not read prompts: ${error}` : '';
      renderPrompts();
    },
  };
}
```

- [ ] **Step 4: Wire it into `extension/src/panel.ts`**

Update the protocol import and add the launcher import:

```ts
import type { ClientMessage, ReviewsState, ServerMessage, Workspace, WorkspaceStatus } from '../../shared/protocol';
import { connectControl, getHelper, openSocket } from './helper-client';
import { createLauncher } from './launcher';
```

After `const newName = ...`, add:

```ts
const newMenu = $<HTMLDivElement>('new-menu');
```

Replace the `statuses` declaration through `const send = ...`:

```ts
let statuses: Record<string, WorkspaceStatus> = {};
let reviews: ReviewsState = { items: [], error: null, fetchedAt: null };

const control = connectControl(
  (message) => {
    if (message.type === 'prompts') launcher.setPrompts(message.prompts, message.error);
    if (message.type !== 'state') return;
    workspaces = workspaceOrder(message.workspaces);
    statuses = message.statuses;
    reviews = message.reviews;
    render();
  },
  (connected) => showNotice(connected ? null : 'Helper not running. Start it with: npm run agent:start'),
);
const send = control.send.bind(control);
const launcher = createLauncher({ send, onToggle: render, openWorkspace });
```

Replace `render`:

```ts
function render(): void {
  renderList();
  launcher.renderReviews(reviews, workspaces);
  const workspace = current();
  pickerEl.hidden = launcher.isOpen || workspace !== undefined;
  terminalEl.hidden = launcher.isOpen || workspace === undefined;
  if (workspace) attach(workspace);
  else {
    detach();
    if (!launcher.isOpen) void renderPicker();
  }
}
```

In `renderList`, replace the item click handler body with a call to a new shared function:

```ts
      item.addEventListener('click', () => {
        if (ws.id !== here?.id) openWorkspace(ws);
      });
```

and add after `renderList`:

```ts
function openWorkspace(ws: Workspace): void {
  // Opening a panel needs a user gesture, so do it before anything awaits.
  if (ws.windowId !== null) chrome.sidePanel.open({ windowId: ws.windowId }).catch(() => {});
  void switchTo(ws, send);
}
```

Replace the `newButton` click listener:

```ts
newButton.addEventListener('click', () => {
  newMenu.hidden = !newMenu.hidden;
});

$<HTMLButtonElement>('new-blank').addEventListener('click', () => {
  newMenu.hidden = true;
  newForm.hidden = false;
  newName.focus();
});

$<HTMLButtonElement>('new-prompt').addEventListener('click', () => {
  newMenu.hidden = true;
  launcher.show(null);
});
```

- [ ] **Step 5: Typecheck and build**

Run: `npm run typecheck && npm run build:extension`
Expected: no errors; `extension/dist/panel.js` rebuilt.

- [ ] **Step 6: Commit**

```bash
git add extension/src/launcher.ts extension/src/panel.ts extension/panel.html extension/panel.css
git commit -m "feat(extension): review requests and prompt picker in the panel"
```

---

### Task 10: Docs and end-to-end check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document it**

In `README.md` under **Using it**, after the **New workspace** bullet, add:

```markdown
- **Review requests:** the section under the list shows open PRs that request your review (from `gh`, refreshed every 5 minutes or with ↻). Click one to pick a prompt; a dot means it already has a workspace, and clicking focuses it.
- **From a prompt:** `+` → **From prompt…** lists the prompts in your vault note. Pick one, edit it (`PR-URL` and `PROJ-XXX` are filled from the PR when there is one), and **Start**: the new workspace's `claude` begins with that prompt. It runs once; reopening the workspace resumes the conversation.
```

Under **Setup**, after the `setup` paragraph, add:

```markdown
Optional fields in `~/.chrome-workspaces/config.json` (`setup` keeps them):

- `promptsFile` — the prompt note (default `~/Documents/Websites/obsidian-vault/Patterns/Most Used Prompts.md`). Each `**Heading**` line starts a section and each `- ` bullet is a prompt.
- `repoDirs` — where PR workspaces start, by repo: `{ "acme/app": "~/Herd/app" }`. Unlisted repos use the default directory.

Review requests need `gh` signed in (`gh auth status`).
```

- [ ] **Step 2: Full verification**

Run: `npx vitest run && npm run typecheck && npm run build:extension`
Expected: all PASS.

- [ ] **Step 3: Manual run (needs Mike; restarting the agent ends open shells)**

1. Add `repoDirs` to `~/.chrome-workspaces/config.json`.
2. `npm run agent:restart`, then reload the extension in `chrome://extensions`.
3. Open the panel: **Review requests (n)** lists the same PRs as `gh search prs --review-requested=@me --state=open`.
4. Click a PR, pick `/code-review max PR-URL`: the textarea shows the PR URL. **Start**: a window opens at the PR, named `app#<n>`, cwd is the mapped repo, and `claude` starts on the prompt.
5. The PR row now shows a dot; clicking it focuses that workspace.
6. Close and reopen the panel in that window: it reattaches; after `/exit` and reopen, it resumes rather than re-sending the prompt.
7. `+` → **From prompt…** → Prod Support Triage → name `triage` → **Start**: a workspace in the default directory starts on the prompt.
8. Temporarily set `promptsFile` to a missing path and restart: the picker shows the read error with the path.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: review requests and prompt workspaces"
```
