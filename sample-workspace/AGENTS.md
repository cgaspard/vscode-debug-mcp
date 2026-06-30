# Sample Workspace — Agent Notes

This is a sample workspace for testing the **VS Code Debug MCP** extension. It provides a real Node.js program with launch configurations and tasks that the MCP tools can interact with.

## Project Structure

- `app.js` — Small Node program with `fib()`, `greet()`, and `main()` functions
- `.vscode/launch.json` — Two Node launch configurations for MCP debugging
- `.vscode/tasks.json` — Three shell tasks (`echo hello`, `list files`, `run sample app`)

## Running the App

```
node app.js
```

## Debugging via MCP

The extension serves a per-window MCP server automatically when this folder is
open in VS Code — there's no port or `.mcp.json` to configure. Register it with
your AI tool via **Debug MCP: Manage AI Harnesses…**.

Typical debugging flow:
1. `list_launch_configurations` — available configs
2. `set_breakpoint file="<path to app.js>" line=<N>` — set breakpoints
3. `start_debugging name="Launch Sample App"` — start a debug session
4. `get_threads` / `get_stack_trace` — inspect state when paused
5. `step_over` / `step_in` / `step_out` — step through code
6. `read_debug_console tail=20` — read console output

## Useful Breakpoint Locations

- `app.js:5` — base case in `fib()`
- `app.js:6` — recursive step in `fib()`
- `app.js:10` — greeting creation in `greet()`
- `app.js:16-18` — name loop in `main()`
- `app.js:22-23` — Fibonacci loop in `main()`

## Available Tasks

- `echo hello` — prints a greeting
- `list files` — runs `ls -la`
- `run sample app` — runs `node app.js`
