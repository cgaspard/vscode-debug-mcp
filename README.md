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

When the extension activates and detects that Claude Code (`anthropic.claude-code`) is installed, it offers to set things up.

**The MCP scope is your choice:**

- **This workspace** — writes `.mcp.json` in the project root. Shared with collaborators via git. Available only in this repo.
- **User settings (all projects)** — runs `claude mcp add --scope user` so `vscode-debug` is registered in `~/.claude.json` and works in **every workspace** you open. Personal to you, not shared with the team.

**The skill is always installed globally** at `~/.claude/skills/debug-mcp/SKILL.md`, regardless of which MCP scope you picked. It's generic guidance (no project-specific content) and Claude Code only auto-loads it when the conversation context matches (debugging, breakpoints, runtime state, etc.) — so a global install doesn't pollute unrelated conversations. The skill teaches Claude to prefer `launch.json` / tasks over raw `Bash`, how to sequence breakpoint/stack/scope drill-downs, and how to call `list_workspaces` / `bind_workspace` in multi-window setups.

**When the prompt re-fires:**

- ✅ User-scope MCP is configured → no prompt, anywhere
- ✅ This workspace's `.mcp.json` already has `vscode-debug` → no prompt
- ⚠️ Neither is configured → prompts on activation, every workspace where you don't have a config
- ❌ You picked "Don't ask again" → never prompts until you run **Debug MCP: Reset Install Prompt**

You can re-open the picker any time:

> **Cmd/Ctrl+Shift+P → Debug MCP: Install Claude Code Support…**

Or, click the **`$(debug-alt) MCP`** indicator in the status bar for a menu with install, copy URL, start/stop, check-for-updates, and other actions.

**Uninstall:** **Debug MCP: Uninstall Claude Code Support…** opens a multi-select picker letting you remove the user-scope registration, the current workspace's `.mcp.json` entry, and/or the global skill. The extension also performs a best-effort skill cleanup on `deactivate()` (when you uninstall the extension itself).

If you'd rather configure manually:

```bash
# In the current project (project scope, .mcp.json):
claude mcp add --transport http vscode-debug http://127.0.0.1:6736/mcp

# Or for all your projects (user scope, ~/.claude.json):
claude mcp add --scope user --transport http vscode-debug http://127.0.0.1:6736/mcp
```

## Architecture

There is **one MCP server per machine**, not per VS Code window. The first window to start binds the HTTP port and becomes the **leader**; subsequent windows become **followers** that join the leader over a local Unix-domain socket and contribute their own workspace to the cluster.

```
                     ┌────────────────────────────────────────────┐
                     │     MCP client (Claude Code / Copilot /    │
                     │              Cursor / Windsurf)            │
                     └───────────────────┬────────────────────────┘
                                         │  Streamable HTTP
                                         │  http://127.0.0.1:6736/mcp
                                         ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  VS Code Window A   ← LEADER                                         │
  │  ───────────────────────────────────────                             │
  │  • Owns HTTP server on port 6736                                     │
  │  • Owns IPC socket at $TMPDIR/vscode-debug-mcp-<pid>.sock            │
  │  • Owns workspace 'monorepo' (id = sha256(path)[:12])                │
  │  • Routes inbound tool calls to the correct workspace                │
  │  • Exposes GET /cluster so other windows can discover it             │
  └─────────┬──────────────────────────────────────────────┬─────────────┘
            │ IPC (line-delimited JSON over Unix socket)   │
            │                                              │
    ┌───────▼─────────────────────┐         ┌──────────────▼──────────────┐
    │  VS Code Window B           │         │  VS Code Window C           │
    │   ← FOLLOWER                │         │   ← FOLLOWER                │
    │  • Workspace 'deviceagent'  │         │  • Workspace 'mlservice'    │
    │  • Tool calls forwarded     │         │  • Tool calls forwarded     │
    │    from leader              │         │    from leader              │
    └─────────────────────────────┘         └─────────────────────────────┘
```

**Discovery (no lockfile)**

1. Window starts → tries `httpServer.listen(6736)`
2. **Success** → it becomes the leader. Done.
3. **`EADDRINUSE`** → it GETs `http://127.0.0.1:6736/cluster`
   - Responder identifies as Debug MCP → it connects to the advertised Unix socket as a follower
   - Anything else → clear error: *"Port 6736 is in use by another process that is not a Debug MCP server."*

The leader's HTTP `/cluster` endpoint is the single source of truth. If the leader crashes hard, its port frees and the next window to call `startServer` naturally becomes the new leader.

**Workspace routing**

The MCP server has no concept of "the current window" — clients say which workspace they want by **MCP session id**. Each chat session in an MCP client gets its own session id, and the leader maintains a `sessionId → workspaceId` map.

| Step | Tool | Effect |
| --- | --- | --- |
| 1 | `list_workspaces` | Returns one entry per VS Code window in the cluster: `{ id, name, path }` |
| 2 | `bind_workspace(workspaceId)` | The leader maps the current MCP session to that workspace. Subsequent tool calls in this session are routed to that window. |
| 3 | `start_debugging`, `set_breakpoint`, etc. | Executed in the leader if `workspaceId == leader.workspace.id`; forwarded over IPC to the matching follower otherwise. |

Without a binding, calls default to the leader's workspace. The bundled debug-mcp skill teaches the AI to call `list_workspaces`/`bind_workspace` at the start of multi-window sessions.

Workspace ids are `sha256(absolute_path).slice(0, 12)` — stable across restarts and window-title changes.

**Failover**

When a follower's heartbeat to the leader times out, the follower drops back to "no role" and retries the discovery flow. Since the leader's port has freed, the follower's `listen(6736)` succeeds and it becomes the new leader. Other followers (if any) detect the same heartbeat loss and re-discover, finding the new leader.

**Status bar**

| Role | Status bar text |
| --- | --- |
| Leader | `$(debug-alt) MCP :6736 (leader)` |
| Follower | `$(debug-alt) MCP (follower)` |
| Standalone (single-window setup) | `$(debug-alt) MCP :6736` |
| Stopped | `$(debug-alt) MCP off` |

Click the indicator for a context-aware action menu — install/reconfigure Claude Code, copy URL, start/stop, check for updates, open log.

## MCP transport

Streamable HTTP at `http://127.0.0.1:6736/mcp` by default. Port, host, and auto-start are configurable under **VS Code Debug MCP** settings.

If the configured port is held by something **other** than a Debug MCP leader (e.g. a different app already grabbed 6736), startup fails with a clear "port held by another process" message instead of a raw `EADDRINUSE`. Change `vscodeDebugMcp.port` in settings to work around it.

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
