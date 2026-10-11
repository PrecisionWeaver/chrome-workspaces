# Setup

Requires macOS, Google Chrome, Node 22+, and `gh` signed in for review requests.

```bash
npm install
npm run gen-key                                    # once: pins the extension ID
npm run setup -- --default-cwd ~/path/to/project   # default: ~
npm run build:extension
npm run agent:start                                # runs the helper now and at login
```

`setup` writes `~/.chrome-workspaces/`, Chrome's native-host manifest, and a LaunchAgent.

In Chrome:

1. `chrome://settings/appearance` → side panel position → **Left**.
2. `chrome://extensions` → Developer mode → **Load unpacked** → `extension/dist`. The ID must match `~/.chrome-workspaces/config.json`.
3. Optional: `chrome://extensions/shortcuts` → bind *Open the workspace panel*.
4. Click the toolbar icon to open the panel.

If the panel reports *native messaging host not found*, rerun `npm run setup` and fully restart Chrome.

## devspace and Mission Control

`devspace PROJ-1234` creates or focuses the ticket's workspace and opens its Jira ticket. Open the panel in that window once. If the helper is unreachable, `devspace` falls back to iTerm + Chrome; `devspace --classic` forces it.

Mission Control's jump button focuses the workspace window for sessions in Chrome Workspaces and uses iTerm otherwise.

## Running the helper

| Command | |
|---|---|
| `npm run agent:start` | Start and enable at login |
| `npm run agent:restart` | Restart (**ends every open shell**) |
| `npm run agent:stop` | Stop and disable at login |
| `npm run agent:status` | Show status |
| `npm run helper` | Run in the foreground (stop the agent first) |

Logs: `~/.chrome-workspaces/helper.log`.
