# Setup

## Requirements

- macOS and Google Chrome.
- Node 24 or newer.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) on your login shell's `PATH`.
- Optional: [`gh`](https://cli.github.com), signed in, for review requests, PR details and CI status.
- Optional: [`btop`](https://github.com/aristocratos/btop) (`brew install btop`) for the system monitor; `top` is used without it.

## Install

The helper is installed from a clone of this repo. The release zip holds only the built extension, so it cannot run the helper on its own.

```bash
git clone https://github.com/PrecisionWeaver/chrome-workspaces.git
cd chrome-workspaces
npm install
npm run install-app -- --default-cwd ~/code --repo-root ~/code
```

`install-app` runs `setup`, builds the extension and starts the helper, then prints the Chrome steps below. Both flags are optional: `--default-cwd` is where new workspaces start (default `~`), and `--repo-root`, repeatable, is a folder whose repos the **Repo** picker lists. Rerunning it is safe.

`setup` writes `~/.chrome-workspaces/`, Chrome's native-host manifest, and a LaunchAgent. It keeps whatever is already in your config.

In Chrome:

1. `chrome://settings/appearance` → side panel position → **Left**.
2. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`.
3. Optional: `chrome://extensions/shortcuts` → bind _Open the workspace panel_.
4. Click the toolbar icon to open the panel.

Settings then shows a **Getting started** checklist for anything still missing.

## When something is wrong

```bash
npm run doctor
```

It checks Node, the config, the extension ID and build, the native-messaging host, the LaunchAgent, whether the helper answers, `claude`, `gh` and the status hooks, and says how to fix each. It works when the panel can't reach the helper.

If Chrome can't find the native host, the panel's notice says the helper is not installed and offers to copy the clone-and-install commands. Run them (or `npm run install-app` in an existing clone) and fully restart Chrome (`npm run setup` alone also registers the host).

## Running the helper

| Command                 |                                              |
| ----------------------- | -------------------------------------------- |
| `npm run agent:start`   | Start and enable at login                    |
| `npm run agent:restart` | Restart (**ends every open shell**)          |
| `npm run agent:stop`    | Stop and disable at login                    |
| `npm run agent:status`  | Show status                                  |
| `npm run helper`        | Run in the foreground (stop the agent first) |

Logs: `~/.chrome-workspaces/helper.log`, with the previous 5 MB or more in `helper.log.1`. Each line starts with its local time; the log records the helper starting and stopping (with the signal and how many terminals that ended), each terminal it starts, GitHub lookups that fail, rate-limit pauses and crashes.

## Scripting workspaces

The helper has a small HTTP API on `127.0.0.1:4178` for shell scripts and other local tools. Every request needs the token in `~/.chrome-workspaces/token` as a bearer header.

| Request                       |                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /workspaces`             | Every workspace, and its status                                                                                                                                                                                                                                                                                                                                             |
| `POST /workspaces`            | Create one from JSON: `name` or `ticket`, and optionally `cwd`, `url` (its first tab), `prompt` (its first message), `worktree` (a branch name: the workspace starts in a new worktree of `cwd` on it, made under the repo's `.claude/worktrees/`), or `pr` (a GitHub PR URL, which fills in the rest). An existing workspace for the same ticket or PR is focused instead. |
| `POST /workspaces/<id>/focus` | Switch Chrome to it                                                                                                                                                                                                                                                                                                                                                         |
| `POST /workspaces/<id>/send`  | Paste JSON `text` into its terminal, never submitted; 409 when it has no running terminal                                                                                                                                                                                                                                                                                   |
| `GET /workspaces/<id>`        | One workspace, its `status` (`working`, `needs_input`, `idle` or null before its claude has started) and, when it needs input, what it is `waiting` on                                                                                                                                                                                                                      |
| `GET /workspaces/<id>/wait`   | Answers once its claude is waiting on you or idle after a turn, with the same `status` and `waiting`, or with `timedOut: true` after `?timeout=` seconds (default 600, at most 3600). A workspace whose claude has not started yet keeps waiting                                                                                                                            |
| `DELETE /workspaces/<id>`     | Archive it: end its session and move it under **Archived**                                                                                                                                                                                                                                                                                                                  |
| `GET /archived`               | Every archived workspace                                                                                                                                                                                                                                                                                                                                                    |
| `POST /archived/<id>/restore` | Bring one back in a window of its own, resuming its conversation                                                                                                                                                                                                                                                                                                            |

```bash
printf 'header = "Authorization: Bearer %s"\n' "$(cat ~/.chrome-workspaces/token)" |
  curl -fsS --config - -H 'Content-Type: application/json' \
    --data '{"ticket":"PROJ-123","cwd":"/Users/me/code/app","url":"https://acme.atlassian.net/browse/PROJ-123"}' \
    http://127.0.0.1:4178/workspaces
```

Passing the header through `--config -` keeps the token out of the process list. A wrapper like this is a quick way to open a workspace per ticket from the terminal.

The same API from a terminal, without the token dance:

```bash
npm link                                    # once, from the project folder: puts `cw` on your PATH

cw list                                     # every workspace and its status
cw status PROJ-123                          # one workspace, and what it is waiting on
cw new PROJ-123 --cwd ~/code/app --worktree PROJ-123
cw focus PROJ-123
cw send PROJ-123 look at the failing test   # pasted, not submitted
cw wait PROJ-123 --timeout 900              # until claude waits on you or finishes; exit code 2 on a timeout
cw rm PROJ-123                              # archive it
cw archived                                 # every archived workspace
cw restore PROJ-123                         # bring one back, resuming its conversation
```

A workspace is named by its id, ticket or name. Without `npm link`, `npm run -s cw -- list` does the same from the project folder; `npm unlink -g chrome-workspaces` takes `cw` off the `PATH` again.

## Uninstall

```bash
npm run uninstall            # stops the helper, removes the LaunchAgent and native-host files
npm run uninstall -- --purge # also deletes ~/.chrome-workspaces (workspaces, config, prompts)
```

Then remove the extension at `chrome://extensions` and delete this folder.
