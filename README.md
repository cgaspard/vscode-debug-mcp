# VS Code Debug MCP

A VS Code extension that exposes a **Model Context Protocol** (MCP) server so AI assistants (Claude Code, Cursor, Copilot, etc.) can drive your debugger, run tasks, launch configurations from `launch.json`, and read terminal and debug-console output — all inside your live VS Code session.

Capabilities:

- Read terminal output (via VS Code shell integration)
- Read the debug console
- Start / stop sessions defined in `launch.json` by name
- Run, list, and stop VS Code tasks

## Transport

Streamable HTTP at `http://127.0.0.1:6736/mcp` by default.
Port, host, and auto-start are configurable under the **VS Code Debug MCP** settings.

## Install & Run (development)

```bash
npm install
npm run compile
```

Open the folder in VS Code and press **F5** to launch an Extension Development Host with the extension active. The status bar shows `MCP :6736` once running; click it to copy the URL.

To produce an installable `.vsix`:

```bash
npm run package
```

Then install the resulting file via `code --install-extension vscode-debug-mcp-*.vsix`.

## Connect from Claude Code

When the extension activates and detects that Claude Code (`anthropic.claude-code`) is installed, it offers a one-time prompt to register the MCP server for you. You pick the scope:

- **This workspace** — writes `.mcp.json` in the project root (shared with collaborators via git)
- **User settings (all projects)** — writes to `~/.claude/settings.json` so it works in every workspace

You can re-open the picker any time via the command palette: **Debug MCP: Configure Claude Code…**.

If you'd rather do it manually:

```bash
claude mcp add --transport http vscode-debug http://127.0.0.1:6736/mcp
```

## Tools exposed

### Launch configurations & sessions
- `list_launch_configurations`
- `start_debugging(name?, workspaceFolder?)`
- `stop_debugging`
- `continue_execution` / `pause_execution`
- `step_over` / `step_in` / `step_out`

### State inspection
- `get_threads`
- `get_stack_trace(threadId?, levels?)`
- `get_scopes(frameId)`
- `get_variables(variablesReference)`
- `evaluate_expression(expression, frameId?, context?)`

### Breakpoints
- `get_all_breakpoints` / `get_breakpoint(id)`
- `set_breakpoint(file, line, condition?, hitCondition?, logMessage?)`
- `remove_breakpoint(id)` / `clear_all_breakpoints`
- `toggle_breakpoint(file, line)`

### Tasks
- `list_tasks`
- `run_task(name, source?)`
- `list_running_tasks`
- `stop_task(name, source?)`

### Terminals
- `list_terminals`
- `read_terminal(idOrName, tail?)` — uses **shell integration**, so output is captured per-command with `$ cmd (exit N)` headers.
- `clear_terminal_buffer(idOrName)`
- `run_in_terminal(command, terminalName?, createIfMissing?)`

### Debug console
- `read_debug_console(tail?)`
- `clear_debug_console_buffer`
- `eval_in_debug_console(expression, frameId?)`

## How terminal capture works

Terminal output is captured using VS Code's [shell integration](https://code.visualstudio.com/docs/terminal/shell-integration) API. This is reliable and clean, but requires:
- A supported shell (bash, zsh, fish, pwsh) with shell integration enabled (it usually is by default in recent VS Code versions).
- Commands typed *after* the terminal has activated shell integration are the ones captured.

If `read_terminal` returns nothing for a terminal, run a command in it first — the buffer fills per-command as commands complete.

## Configuration

| Setting | Default | Description |
|---|---|---|
| `vscodeDebugMcp.port` | `6736` | HTTP port to bind |
| `vscodeDebugMcp.host` | `127.0.0.1` | Bind interface (localhost only by default) |
| `vscodeDebugMcp.autoStart` | `true` | Start the server when the extension activates |
| `vscodeDebugMcp.terminalBufferLines` | `2000` | Max lines retained per captured terminal/debug-console buffer |

## Security note

The server only binds to `127.0.0.1` by default and has no authentication. Don't expose it on a public interface unless you've added auth in front (e.g. via a reverse proxy or SSH tunnel).

## License

MIT
