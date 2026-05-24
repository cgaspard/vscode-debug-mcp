# VS Code Debug MCP

A VS Code extension that lets AI assistants — Claude Code, Copilot agent mode, Cursor, Windsurf, anything that speaks MCP — drive your debugger, run launch configurations and tasks, set breakpoints, and read terminal and debug-console output, all inside your live VS Code session.

Capabilities:

- Read terminal output (via VS Code shell integration)
- Read the debug console
- Start / stop sessions defined in `launch.json` by name
- Run, list, and stop VS Code tasks
- Set, list, toggle, and clear breakpoints
- Inspect threads, stack frames, scopes, variables; evaluate expressions

Two surfaces in one extension:

1. **MCP server (Streamable HTTP)** — for Claude Code, Cursor, and any other MCP client.
2. **Language Model Tools** — for GitHub Copilot Chat agent mode. No MCP setup needed; Copilot picks them up automatically once the extension is installed.

## Install

### From GitHub release (no marketplace needed)

One-liner (always installs the latest release):

```bash
# macOS / Linux
curl -L https://github.com/cgaspard/vscode-debug-mcp/releases/latest/download/vscode-debug-mcp.vsix -o /tmp/vscode-debug-mcp.vsix && code --install-extension /tmp/vscode-debug-mcp.vsix
```

```powershell
# Windows PowerShell
Invoke-WebRequest https://github.com/cgaspard/vscode-debug-mcp/releases/latest/download/vscode-debug-mcp.vsix -OutFile $env:TEMP\vscode-debug-mcp.vsix; code --install-extension $env:TEMP\vscode-debug-mcp.vsix
```

The URL ends in `vscode-debug-mcp.vsix` (no version) so it stays valid across releases.

Or download from the [Releases page](https://github.com/cgaspard/vscode-debug-mcp/releases/latest) and use **Extensions view → … menu → Install from VSIX…**

After the first install the extension auto-checks GitHub every 6 hours and offers to download and install new versions in-product. You can also run **Cmd/Ctrl+Shift+P → Debug MCP: Check for Updates** at any time.

### From source (development)

```bash
git clone https://github.com/cgaspard/vscode-debug-mcp
cd vscode-debug-mcp
npm install
npm run compile
```

Open the folder in VS Code and press **F5** to launch an Extension Development Host. Or `npm run package` to produce a local `.vsix`.

## Use with Copilot (agent mode)

Once installed, Copilot's agent mode sees the tools immediately — no configuration. The tools are namespaced `debugMcp_*` (e.g. `debugMcp_start_debugging`, `debugMcp_run_task`). Write-y tools (start/stop debug, run/stop task, set/clear breakpoints, run in terminal, evaluate) confirm with the user before invoking; read-only tools run silently.

## Use with Claude Code

When the extension activates and detects that Claude Code (`anthropic.claude-code`) is installed, it offers a one-time prompt to set things up for you. You pick a scope:

- **This workspace** — writes `.mcp.json` in the project root and `.claude/skills/debug-mcp/SKILL.md` (both shared via git)
- **User settings (all projects)** — writes to `~/.claude/settings.json` and `~/.claude/skills/debug-mcp/SKILL.md` so both work in every workspace

A second prompt asks whether to also install the **debug-mcp usage skill** — a markdown file Claude Code auto-loads when relevant. The skill teaches Claude to prefer `launch.json` / tasks over raw `Bash`, how to sequence breakpoint/stack/scope drill-downs, and which gotchas to watch for. Recommended.

You can re-open the picker any time:

> **Cmd/Ctrl+Shift+P → Debug MCP: Install Claude Code Support…**

Or, click the **`$(debug-alt) MCP`** indicator in the status bar for a menu with install, copy URL, start/stop, check-for-updates, and other actions.

If you'd rather configure manually:

```bash
claude mcp add --transport http vscode-debug http://127.0.0.1:6736/mcp
```

## MCP transport

Streamable HTTP at `http://127.0.0.1:6736/mcp` by default. Port, host, and auto-start are configurable under **VS Code Debug MCP** settings.

### Multi-window

There is one MCP server per machine, not per window. Each VS Code window with the extension installed automatically negotiates a role:

- **Leader** — the first window to start owns the HTTP server on the configured port.
- **Followers** — subsequent windows register with the leader over a local Unix socket. Their workspace is reachable through the leader's MCP endpoint.

The status bar shows the role: `MCP :6736 (leader)` or `MCP (follower)`.

When an AI talks to the leader's MCP endpoint, it can:

1. Call `list_workspaces` to see all windows.
2. Call `bind_workspace(workspaceId)` to lock subsequent calls in that chat session to a specific window.

Tools that don't have a binding default to the leader's workspace. The bundled debug-mcp usage skill teaches this flow.

If the leader window closes, followers race to promote themselves — first one to grab the port becomes the new leader; the others re-register.

## Tools exposed (MCP names; Copilot uses `debugMcp_` prefix)

### Multi-window
- `list_workspaces`
- `bind_workspace(workspaceId)`

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
- `read_terminal(idOrName, tail?)` — uses **shell integration**, so output is captured per-command with `$ cmd` / `[exit N]` markers.
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
| `vscodeDebugMcp.autoStart` | `true` | Start the MCP server when the extension activates |
| `vscodeDebugMcp.terminalBufferLines` | `2000` | Max lines retained per captured terminal/debug-console buffer |

## Updates

The extension auto-checks GitHub Releases every 6 hours (silently — no notification unless an update is available). When a new release exists, you'll see a notification offering to download and install the new `.vsix`. You can also:

- Run **Debug MCP: Check for Updates** from the command palette
- Click the MCP status-bar item and pick **Check for updates**

No marketplace required. Skipped versions are remembered until the next release.

## Security note

The MCP server only binds to `127.0.0.1` by default and has no authentication. Don't expose it on a public interface unless you've added auth in front (e.g. via a reverse proxy or SSH tunnel).

## License

MIT
