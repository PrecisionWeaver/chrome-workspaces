# Review Requests and Prompt Workspaces - Design

**Date:** 2026-10-07
**Status:** Approved, not built

## Problem

Mike starts most review and support sessions by typing one of a handful of reusable prompts (`/code-review max PR-URL`, `/pr-comments PR-URL`, `/quest - PROJ-XXX`, ...) into a fresh `claude`. The prompts live in his Obsidian vault, and the PRs waiting on him live in GitHub. He wants the panel to show PRs that request his review and to start a workspace with a chosen prompt already running.

## Shape

Two ways to start a prompted workspace:

1. **From a review request:** pick an open PR that requests his review, then pick a prompt.
2. **From a prompt alone:** pick a prompt with no PR, e.g. Prod Support Triage.

Either way the chosen prompt opens in an editable textarea with placeholders filled where possible. **Start** creates the workspace, and `claude` begins with that prompt as its first message.

```
┌──────────────────────┐
│ 1 PROJ-1234           │
│▸2 app#482   │
│ +                    │   + offers: Blank | From prompt...
├──────────────────────┤
│ Review requests (3) ↻│
│  app#490  ● │   ● = already has a workspace (click focuses it)
│  app#491    │
│  orion-infra#77      │
└──────────────────────┘
```

## Helper

### Prompts (`helper/src/prompts.ts`)

- Reads the file at config `promptsFile`, default `~/Documents/Websites/obsidian-vault/Patterns/Most Used Prompts.md`.
- Parses it into `Prompt[]` of `{ section: string; text: string }`. A line that is only `**Heading**` starts a section; each `- ` bullet under it is one prompt, with the leading `- ` and surrounding whitespace removed. Bullets before the first heading go under section `""`. Blank lines and other lines are ignored.
- Re-reads the file on every request so Obsidian edits show up without a restart. A missing or unreadable file is an error the panel shows, never an empty list.
- `fillPrompt(text, { prUrl, ticket })` lives in `shared/prompts.ts` so the panel can use it. It replaces every standalone `PR-URL` with `prUrl` and every `PROJ-XXX` with `ticket` when each is known (`PR-URL-1` is not standalone and stays), and leaves the placeholder untouched otherwise. Nothing else is substituted (`NAME`, `X`, and similar are for the user to edit).

### Review requests (`helper/src/reviews.ts`)

- Runs `gh search prs --review-requested=@me --state=open --json number,title,url,repository,author,isDraft,updatedAt --limit 50` through the login shell (`$SHELL -l -c`), because launchd's `PATH` does not include Homebrew.
- Parses the output into `ReviewRequest[]`: `{ repo: string /* owner/name */; number: number; title: string; url: string; author: string; isDraft: boolean; updatedAt: string; ticket: string | null }`. `ticket` is the first `[A-Z][A-Z0-9]*-\d+` match in the title outside square brackets (a bracketed key, as in `[PROJ-1731] PROJ-1737 - ...`, names the parent), else the first match anywhere, else `null`.
- Polls every 5 minutes, and on demand when the panel sends `refreshReviews`. An overlapping request reuses the poll in flight.
- On failure (`gh` missing, auth expired, non-zero exit, unparseable JSON) it keeps the last good list and records the error message. The state carries both, so the panel shows a stale list with the error rather than an empty one.

### Config

`config.json` gains two optional fields:

- `promptsFile: string`, default above.
- `npm run setup` keeps any fields it does not manage when it rewrites `config.json`.
- `repoDirs: Record<string, string>` mapping `owner/name` to an absolute directory, e.g. `{ "acme/app": "/Users/me/Herd/app" }`. A leading `~/` is expanded. A PR from a repo not in the map, or mapped to a directory that does not exist, starts in `defaultCwd`.

### Workspace

`Workspace` gains:

- `pr: string | null` - the PR URL the workspace was created for.
- `prompt: string | null` - the first message for `claude`. The helper clears it once a session has been launched with it, so it runs exactly once.

Stored workspaces without these fields load as `null`.

`WorkspaceStore` gains `findByPr(url)` and `clearPrompt(id)`.

### Launch

`launchSpec` takes the workspace's `prompt`. When there is a prompt and no valid resume id, it sets `CW_PROMPT` in the session env and the claude command becomes `hr "$CW_PROMPT"` / `claude "$CW_PROMPT"`. The prompt text never enters the command string, so no escaping is needed. With a resume id, the prompt is ignored and resume behaves as today. `main.ts` calls `store.clearPrompt(id)` after creating a session that used it.

## Protocol

```ts
interface Prompt { section: string; text: string }
interface ReviewRequest { repo: string; number: number; title: string; url: string; author: string; isDraft: boolean; updatedAt: string; ticket: string | null }

// ControlToClient: state gains
{ type: 'state'; workspaces; statuses; reviews: { items: ReviewRequest[]; error: string | null; fetchedAt: string | null } }
// ControlToClient: new
{ type: 'prompts'; prompts: Prompt[] } | { type: 'prompts'; error: string }

// ControlToHelper: create gains optional fields
{ type: 'create'; name: string; windowId: number | null; pr?: string; prompt?: string }
// ControlToHelper: new
{ type: 'refreshReviews' } | { type: 'listPrompts' }
```

`create` with `pr`:
- If a workspace already has that `pr`, the helper sends `focus` for it and creates nothing.
- Otherwise the workspace is named `<repo name>#<number>` (e.g. `app#482`), `ticket` is the PR's ticket key or `null`, `url` is the PR URL, and `cwd` comes from `repoDirs`. The helper looks the PR up in its current review list to get the repo and ticket; a PR URL not in the list is parsed for `owner/name` and number from `https://github.com/<owner>/<name>/pull/<n>`, and anything else is rejected.

`create` with only `prompt` behaves like today's `create` with the prompt stored. `prompt` is limited to 8000 characters.

The HTTP `POST /workspaces` accepts the same optional `pr` and `prompt` fields with the same rules, so `devspace` and other tools can use them later.

## Panel

- **Review requests section** below the workspace list, collapsible, titled `Review requests (n)` with a refresh button. Each row shows `repo-name#number`, the title (truncated, full title on hover), a `draft` tag when `isDraft`, and a dot when a workspace with that `pr` exists. Clicking a row with a workspace focuses that workspace; clicking any other row opens the prompt picker for it. An error from the helper shows as one line under the heading.
- **`+`** opens a two-item menu: **Blank** (today's behavior) and **From prompt...** (prompt picker with no PR).
- **Prompt picker** replaces the list area while open. A filter box at the top matches section and text case-insensitively, and prompts are listed grouped by section. Choosing one shows a textarea with the filled prompt, a name field (prefilled with `repo#number` for a PR, empty otherwise and required), **Start**, and **Back**. Esc closes the picker. **Start** sends `create` with `windowId: null`, `pr` and `prompt`, and the service worker opens the new window as it does for `devspace`.

## Errors

- Prompts file missing or unreadable: the picker shows the error and the path it tried.
- `gh` failure: the section shows the error, keeps the last good list, and the refresh button retries.
- Invalid `create` input (bad PR URL, prompt too long, empty name): the helper ignores the control message and logs it; the HTTP API returns 400.

## Testing

- `prompts.test.ts`: parsing headings, bullets, bullets before any heading, blank lines; `fillPrompt` with both, either, and neither value known.
- `reviews.test.ts`: parsing `gh` JSON, ticket extraction from titles, keeping the last good list on failure, reusing an in-flight poll. `gh` is injected as a function so tests never run it.
- `launch.test.ts`: `CW_PROMPT` set and used when a prompt is present without a resume id; ignored with one.
- `workspace-store.test.ts`: `findByPr`, `clearPrompt`, and loading a file written without the new fields.
- `control.test.ts` and `api.test.ts`: create from PR (name, ticket, cwd from `repoDirs`, fallback to `defaultCwd`), duplicate PR focuses, prompt-only create, rejected inputs, `listPrompts`, `refreshReviews`.

## Out of scope

- Fetching PRs for anything other than review requests (authored PRs, team requests).
- Writing prompts back to the vault from the panel.
- Checking out the PR branch or creating worktrees.
