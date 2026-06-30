# Sample Workspace

This folder exists to give the **VS Code Debug MCP** extension something real to act on while you're testing it.

It contains:
- [app.js](./app.js) — a small Node program with a few functions to set breakpoints on
- [.vscode/launch.json](./.vscode/launch.json) — two launch configurations the MCP `list_launch_configurations` / `start_debugging` tools will see
- [.vscode/tasks.json](./.vscode/tasks.json) — three tasks the MCP `list_tasks` / `run_task` tools will see

Open this folder in VS Code with the extension installed. The extension serves a
per-window MCP server automatically — there's no port to configure and no
`.mcp.json` to hand-edit. Connect your AI tool via **Debug MCP: Manage AI
Harnesses…** (status-bar menu) to register it with Claude Code, opencode, Codex,
or a portable project `.mcp.json`.

## app.js

The sample program defines three functions:

- **`fib(n)`** — recursive Fibonacci; returns `n` for `n < 2`, otherwise `fib(n-1) + fib(n-2)`
- **`greet(name)`** — returns a greeting string (`hello, <name>`)
- **`main()`** — iterates over `['alice', 'bob', 'carol']`, prints a greeting for each, then computes and prints `fib(0)` through `fib(7)`. A 250ms `setTimeout` keeps the process alive so debug-console reads can catch the output.

Useful breakpoint locations:
- Line 5 — base case inside `fib`
- Line 6 — recursive step inside `fib`
- Line 10 — greeting creation inside `greet`
- Line 16–18 — the name loop in `main`
- Line 22–23 — the Fibonacci loop in `main`

## Try these via MCP

From an MCP client (e.g. Claude Code) connected to this window's Debug MCP server:

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
