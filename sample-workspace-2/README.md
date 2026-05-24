# Sample Workspace #2

A second sample target so you can test the **multi-window cluster** behavior of the Debug MCP extension. Open this folder in a different VS Code window from [`sample-workspace`](../sample-workspace) and the extension should detect the leader window and register this one as a follower.

Contents:
- [server.js](./server.js) — a tiny HTTP server (different program from sample-workspace's `app.js`)
- [.vscode/launch.json](./.vscode/launch.json) — two launch configs (`Launch Sample Server`, `Launch Sample Server (port 7200)`)
- [.vscode/tasks.json](./.vscode/tasks.json) — two tasks (`ping server`, `show date`)

## Try multi-window via MCP

Open both `sample-workspace` and `sample-workspace-2` in two VS Code Extension Development Host windows. The Debug MCP status bar should show `MCP :6736 (leader)` in the first window and `MCP (follower)` in the second.

Then in any MCP client (e.g. Claude Code), connect to `http://127.0.0.1:6736/mcp` and try:

```
list_workspaces
# pick the id whose name is "sample-workspace-2"
bind_workspace workspaceId="<that id>"
list_launch_configurations
# should show "Launch Sample Server", NOT "Launch Sample App"
list_tasks
# should show "ping server" and "show date"
run_task name="show date"
# look at the OTHER window — that terminal should have the output
```

Now swap:

```
list_workspaces
# pick the id whose name is "sample-workspace"
bind_workspace workspaceId="<that id>"
list_launch_configurations
# now shows "Launch Sample App"
start_debugging name="Launch Sample App"
# the OTHER window should jump to debug view
```

The AI should never see commands from sample-workspace appear in sample-workspace-2's window.
