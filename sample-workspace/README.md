# Sample Workspace

This folder exists to give the **VS Code Debug MCP** extension something real to act on while you're testing it.

It contains:
- [app.js](./app.js) — a small Node program with a few functions to set breakpoints on
- [.vscode/launch.json](./.vscode/launch.json) — two launch configurations the MCP `list_launch_configurations` / `start_debugging` tools will see
- [.vscode/tasks.json](./.vscode/tasks.json) — three tasks the MCP `list_tasks` / `run_task` tools will see

## Try these via MCP

From an MCP client (e.g. Claude Code) connected to `http://127.0.0.1:6736/mcp`:

```
list_launch_configurations
list_tasks
run_task name="echo hello"
set_breakpoint file="<absolute path to app.js>" line=6
start_debugging name="Launch Sample App"
get_threads
get_stack_trace
step_over
read_debug_console tail=20
```
