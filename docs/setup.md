# Setup

## Requirements

- macOS and Google Chrome.
- Node 22.18 or newer.
- [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) on your login shell's `PATH`.
- Optional: [`gh`](https://cli.github.com), signed in, for review requests, PR details and CI status.
- Optional: [`btop`](https://github.com/aristocratos/btop) (`brew install btop`) for the system monitor; `top` is used without it.

## Install

```bash
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

If Chrome can't find the native host, the panel's notice says the helper is not installed and offers to copy `npm run install-app`. Run it from the project folder and fully restart Chrome (`npm run setup` alone also registers the host).

## Running the helper

| Command                 |                                              |
| ----------------------- | -------------------------------------------- |
| `npm run agent:start`   | Start and enable at login                    |
| `npm run agent:restart` | Restart (**ends every open shell**)          |
| `npm run agent:stop`    | Stop and disable at login                    |
| `npm run agent:status`  | Show status                                  |
| `npm run helper`        | Run in the foreground (stop the agent first) |

Logs: `~/.chrome-workspaces/helper.log`, with the previous 5 MB or more in `helper.log.1`.

## Scripting workspaces

The helper has a small HTTP API on `127.0.0.1:4178` for shell scripts and other local tools. Every request needs the token in `~/.chrome-workspaces/token` as a bearer header.

| Request                       |                                                                                                                                                                                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /workspaces`             | Every workspace, and its status                                                                                                                                                                                                              |
| `POST /workspaces`            | Create one from JSON: `name` or `ticket`, and optionally `cwd`, `url` (its first tab), `prompt` (its first message), or `pr` (a GitHub PR URL, which fills in the rest). An existing workspace for the same ticket or PR is focused instead. |
| `POST /workspaces/<id>/focus` | Switch Chrome to it                                                                                                                                                                                                                          |
| `DELETE /workspaces/<id>`     | End its session and remove it                                                                                                                                                                                                                |

```bash
printf 'header = "Authorization: Bearer %s"\n' "$(cat ~/.chrome-workspaces/token)" |
  curl -fsS --config - -H 'Content-Type: application/json' \
    --data '{"ticket":"PROJ-123","cwd":"/Users/me/code/app","url":"https://acme.atlassian.net/browse/PROJ-123"}' \
    http://127.0.0.1:4178/workspaces
```

Passing the header through `--config -` keeps the token out of the process list. A wrapper like this is a quick way to open a workspace per ticket from the terminal.

## Uninstall

```bash
npm run uninstall            # stops the helper, removes the LaunchAgent and native-host files
npm run uninstall -- --purge # also deletes ~/.chrome-workspaces (workspaces, config, prompts)
```

Then remove the extension at `chrome://extensions` and delete this folder.
