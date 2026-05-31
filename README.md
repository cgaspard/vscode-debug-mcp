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

1. **MCP server (per-window, over a local socket)** — for Claude Code, Cursor, and any other MCP client. Each VS Code window runs its own server on a private Unix domain socket (named pipe on Windows); there is no shared TCP port.
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

**One registration, every workspace.** The installer registers a single **stdio** server named `vscode-debug` at user scope (in `~/.claude.json`). It points Claude Code at a small bridge that resolves the *current* window's socket at spawn time, so the same entry works in every workspace you open — there is no per-project `.mcp.json` to manage and no scope to pick. The only choice the installer asks about is whether to also install the usage skill.

**The skill is installed globally** at `~/.claude/skills/debug-mcp/SKILL.md`. It's generic guidance (no project-specific content) and Claude Code only auto-loads it when the conversation context matches (debugging, breakpoints, runtime state, etc.) — so a global install doesn't pollute unrelated conversations. The skill teaches Claude to prefer `launch.json` / tasks over raw `Bash`, and how to sequence breakpoint/stack/scope drill-downs.

**Self-healing across updates.** The bridge lives inside the extension's install directory, whose path changes on every version bump. On activation the extension checks whether your `vscode-debug` registration points at the current build and silently re-points it if not — so updates don't break the integration. Upgrading from an older HTTP-based version replaces the old entry in place under the same `vscode-debug` name, so the `mcp__vscode-debug__*` tool prefix (and any skills/allowlists referencing it) keep working.

**When the prompt re-fires:**

- ✅ User-scope MCP is configured → no prompt, anywhere
- ⚠️ Not configured → prompts on activation
- ❌ You picked "Don't ask again" → never prompts until you run **Debug MCP: Reset Install Prompt**

You can re-open the installer any time:

> **Cmd/Ctrl+Shift+P → Debug MCP: Install Claude Code Support…**

Or, click the **`$(debug-alt) Debug MCP`** indicator in the status bar for a menu with install, start/stop, check-for-updates, and other actions.

**Uninstall:** **Debug MCP: Uninstall Claude Code Support…** opens a multi-select picker letting you remove the user-scope registration and/or the global skill. The extension also performs a best-effort skill cleanup on `deactivate()` (when you uninstall the extension itself).

If you'd rather configure manually, register the bridge at user scope (one entry works everywhere):

```bash
claude mcp add-json --scope user vscode-debug \
  '{"type":"stdio","command":"node","args":["<path-to-extension>/out/bridge.js"]}'
```

Replace `<path-to-extension>` with the extension's install directory (the **Install Claude Code Support…** command fills this in for you, using the exact Node that runs VS Code).

## The most common workflow: user-started debug sessions

Most debugging conversations don't start with "AI, launch this for me" — they start with the user hitting **F5**, running into a breakpoint, then asking the AI a question. The extension listens to **every** debug session via VS Code's `DebugAdapterTracker` API, including ones the user starts themselves. The AI can:

1. Call `list_debug_sessions` to see what's currently running or recently paused.
2. Call `get_last_stopped_event` to read the file, line, frame, and stack trace from the most recent pause — *preserved even after the user continues execution*.
3. Inspect threads / scopes / variables on a still-paused session, or set new breakpoints on a running one and let it hit.

The bundled `debug-mcp` skill teaches the AI to do this check first before considering whether to start a new session.

## Architecture

**One MCP server per VS Code window.** Each window binds its own Unix domain socket (a named pipe on Windows), named deterministically from the workspace folder. There is no shared TCP port, and no coordination between windows — each window is independently addressable.

Claude Code reaches the right window through a tiny **stdio bridge** that it spawns as a subprocess. The bridge figures out which workspace it belongs to (from `CLAUDE_PROJECT_DIR`, which Claude Code sets to the project root), computes the same socket name the extension used, and relays raw JSON-RPC bytes between Claude Code's stdin/stdout and the window's socket. Because `claude` runs in the context of one window, the process tree pins each session to the correct window automatically.

```
   VS Code Window A                         VS Code Window B
  ┌────────────────────────────┐           ┌────────────────────────────┐
  │  extension host            │           │  extension host            │
  │  • MCP server (full tool   │           │  • MCP server              │
  │    schemas, vscode.debug.*)│           │  • workspace B             │
  │  • listens on UDS:         │           │  • listens on UDS:         │
  │    …/vscode-debug-mcp-     │           │    …/vscode-debug-mcp-     │
  │    <hash(pathA)>.sock      │           │    <hash(pathB)>.sock      │
  └─────────────▲──────────────┘           └─────────────▲──────────────┘
                │ JSON-RPC over socket                   │
        ┌───────┴────────┐                       ┌───────┴────────┐
        │  bridge.js     │                       │  bridge.js     │
        │  (stdio↔socket)│                       │  (stdio↔socket)│
        └───────▲────────┘                       └───────▲────────┘
                │ stdio                                  │ stdio
     ┌──────────┴──────────┐                  ┌──────────┴──────────┐
     │ claude (in window A)│                  │ claude (in window B)│
     └─────────────────────┘                  └─────────────────────┘
```

**Socket naming**

Each window listens at `$TMPDIR/vscode-debug-mcp/<id>.sock` where `<id> = sha256(workspace_path).slice(0, 12)` (on Windows, `\\.\pipe\vscode-debug-mcp-<id>`). The bridge computes the identical name from `CLAUDE_PROJECT_DIR`, so discovery needs no config and no central registry in the common case.

**Bridge socket resolution order**

1. `$VSCODE_DEBUG_MCP_SOCK` if set (explicit override).
2. The deterministic path from `$CLAUDE_PROJECT_DIR` (or the bridge's cwd) — the common case.
3. A per-user registry at `~/.claude/vscode-debug/registry.json` mapping `workspacePath → socketPath`, written by each window. This covers multi-root workspaces, `.code-workspace` files, and the rare case of the same folder open in two windows (where the second window falls back to a pid-disambiguated socket).

**Resilience**

The bridge keeps Claude Code's session alive across window reloads: if the socket drops (e.g. you reload the VS Code window), the bridge transparently retries the connection rather than exiting. Stdio MCP servers aren't auto-restarted by Claude Code, so this self-reconnect is what makes a reload non-fatal.

**Status bar**

| State | Status bar text |
| --- | --- |
| Running | `$(debug-alt) Debug MCP` |
| Stopped | `$(debug-alt) MCP off` |

Click the indicator for a context-aware action menu — install/reconfigure Claude Code, start/stop, check for updates, open log.

## Tools exposed (MCP names; Copilot uses `debugMcp_` prefix)

### Sessions (works for **user-started** sessions too!)
- `list_debug_sessions` — every active or recently terminated debug session, with status (`running`/`paused`/`terminated`) and a snapshot of the most recent stopped event when present. **The AI should call this first** when the user mentions runtime behavior — they may already be paused at a breakpoint.
- `get_last_stopped_event(sessionId?, levels?)` — snapshot of the most recent pause: `{ reason, threadId, frame, stackTrace }`. Survives the user continuing execution (snapshot is captured at pause time), so you can still read where they were stopped even after they resumed.

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
| `vscodeDebugMcp.autoStart` | `true` | Start the per-window MCP server when the extension activates |
| `vscodeDebugMcp.terminalBufferLines` | `2000` | Max lines retained per captured terminal/debug-console buffer |

## Updates

The extension auto-checks GitHub Releases every 6 hours (silently — no notification unless an update is available). When a new release exists, you'll see a notification offering to download and install the new `.vsix`. You can also:

- Run **Debug MCP: Check for Updates** from the command palette
- Click the MCP status-bar item and pick **Check for updates**

No marketplace required. Skipped versions are remembered until the next release.

## Security note

The MCP server listens on a **Unix domain socket** (a named pipe on Windows), not a network port, so it is reachable only by processes on the same machine running as the same user — the socket file is created under the user's temp directory. There is no network listener to expose. The bridge that Claude Code spawns connects to that local socket and relays JSON-RPC; it opens no ports of its own.

## License

MIT
