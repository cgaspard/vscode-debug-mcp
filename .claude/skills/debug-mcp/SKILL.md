---
name: debug-mcp
description: Use this skill when the user is debugging a running program, investigating a crash, looking into why something is failing at runtime, reproducing a bug, stepping through code execution, inspecting state in a paused program, asking questions that depend on values at runtime, or asking you to "run" something they want to interact with. Provides guidance for driving the VS Code Debug MCP server tools — preferring VS Code's launch.json and tasks.json over raw Bash so the user can interact with the running process in their editor.
---

# Debug MCP — driving VS Code from your tool calls

This skill is for the [`vscode-debug-mcp`](https://github.com/cgaspard/vscode-debug-mcp) extension. The tools below run *inside* the user's live VS Code window — every action (launching a program, setting a breakpoint, running a task) is visible to the user in their editor, and the user can interact with the running session normally (set their own breakpoints, type in the integrated terminal, evaluate in the debug console).

**This is the headline insight: when you launch via these tools, the user is a participant, not a spectator.** A `Bash` invocation gives you output and ends. A `start_debugging` or `run_task` call hands the user a real, interactive VS Code session they can drive alongside you.

## When to reach for these tools (vs. Bash)

**Prefer these tools over `Bash` whenever the user might want to interact with the process:**

| Situation | Wrong | Right |
| --- | --- | --- |
| User wants to "run the app and see what happens" | `Bash node app.js` | `start_debugging` with a launch.json config (or create one) |
| User wants to run tests they may want to debug | `Bash npm test` | `run_task` (their npm test task) or `start_debugging` (Jest/Mocha launch config) |
| Build/lint/format where output is all you need | (Bash is fine) | `Bash` |
| User wants to reproduce a runtime bug | `Bash` then read logs | `start_debugging` so they can set breakpoints |
| User says "start the server" | `Bash npm start` (orphans on next call) | `run_task` (managed by VS Code, visible, can be stopped) |

The user already configured their preferred way to run things in [`launch.json`](https://code.visualstudio.com/docs/editor/debugging) and [`tasks.json`](https://code.visualstudio.com/docs/editor/tasks). Use those configurations — they bake in the correct working directory, env vars, args, debugger type, and pre-launch steps. Re-deriving that in `Bash` is fragile and bypasses everything the user set up.

**Use these tools when:**
- The user is investigating a runtime bug, crash, or unexpected behavior
- The user wants to *run something* (program, tests, server) and may want to interact with it
- A test or program is failing and the root cause isn't obvious from reading the code
- You need to inspect runtime values, stack frames, or threaded state
- You need terminal/debug-console output from a long-running process the user can see

**Don't use them for:**
- Static code review, refactoring, or syntax questions
- Reading files (use Read — much cheaper)
- One-shot non-interactive commands where you only need the output (Bash is fine)
- Exploring the codebase ("where is X defined?") — these tools are for live state

## The launch-vs-bash decision flow

Before reaching for `Bash` to start a process, ask: **"Will the user want to interact with this once it's running?"**

If yes → use these tools, in this priority order:

1. **Is there an existing launch.json config that matches?** Call `list_launch_configurations` first. If one matches the user's intent, call `start_debugging` with that name. The user gets a full debug session: breakpoints, variables panel, debug console, the works.
2. **Is there an existing tasks.json task that matches?** Call `list_tasks`. If one matches, call `run_task`. Tasks are right for long-running processes (dev servers, watchers) and for build-style operations where you want VS Code to track the running state.
3. **Neither exists, but the user clearly wants something runnable?** Offer to *add* a launch config or task to their workspace. Show the proposed JSON, get their OK, then write it. They keep the config for next time.
4. **It's truly a one-shot non-interactive command?** `Bash` is fine.

If no, the user just wants output: `Bash` is fine.

### Why this matters

When you `Bash node app.js`, the process is yours. It runs in *your* Bash session, the user can't see its terminal, can't stop it gracefully, can't set breakpoints, and the process gets orphaned the moment your next tool call returns. The user has to ask you "is it still running?" — they're flying blind.

When you `start_debugging`, the process runs in *the user's* VS Code. They see the terminal, they can poke at breakpoints, they can stop it with the debug toolbar, they can attach the debugger to inspect a hang. You can read the debug console output via `read_debug_console` whenever you need it. Total visibility, total user agency.

## Multi-window setups: bind to a workspace first

If the user has multiple VS Code windows open, they all share a **single Debug MCP server** running in one "leader" window. The other windows register as followers. Every tool call has to know *which* window to target.

**At the start of any session (or whenever the user switches focus to a different repo), call `list_workspaces` first.** It returns one entry per open VS Code window with `{ id, name, path }`.

- **Single workspace returned**: nothing to do. All tool calls go there automatically.
- **Multiple workspaces returned**: figure out which one the user wants based on (a) the paths of files they're @-mentioning, (b) names they say out loud, (c) the active editor selection's file path. Then call `bind_workspace({ workspaceId: "<id>" })` to lock subsequent calls to that window.
- **User switches mid-conversation** ("now work in the other window"): call `list_workspaces` again, pick the new one, call `bind_workspace`.

Without `bind_workspace`, calls go to the leader window's workspace by default. That's fine for single-window setups but probably wrong if the user opened the leader for a completely different project.

`bind_workspace` is session-scoped — it only affects the current MCP chat session, and the binding clears when the session ends.

## Tool catalog

### Multi-window
- `list_workspaces` — list all VS Code windows registered with this MCP cluster. Each has `{ id, name, path }`.
- `bind_workspace(workspaceId)` — bind this MCP session to a specific workspace by id. All subsequent calls in this session route to that window.

### Launch & sessions
- `list_launch_configurations` — what's in `launch.json`. **Call this first** before suggesting a launch.
- `start_debugging(name?, workspaceFolder?)` — start a session by configuration name. Omit `name` for the workspace default.
- `stop_debugging` — terminate the active session.
- `continue_execution`, `pause_execution`, `step_over`, `step_in`, `step_out` — execution control. All take optional `threadId`; omit to target the first thread.

### Tasks
- `list_tasks` — all tasks visible to VS Code (workspace + extension-contributed).
- `run_task(name, source?)` — execute a task by name. `source` disambiguates when multiple tasks share a name (e.g. `"Workspace"` vs `"npm"`).
- `list_running_tasks` — what's currently executing.
- `stop_task(name, source?)` — terminate a running task.

### State inspection (only meaningful while paused at a breakpoint)
- `get_threads` — usually one in a normal program, more in multithreaded code.
- `get_stack_trace(threadId?, levels?)` — frames from top of stack down.
- `get_scopes(frameId)` — what's in scope at a frame (Local, Closure, Global).
- `get_variables(variablesReference)` — expand a scope or a parent variable. References are returned by `get_scopes` and other variables — not stable across sessions or after `continue_execution`.
- `evaluate_expression(expression, frameId?, context?)` — evaluate in the paused context. `context: 'repl'` is the default; use `'watch'` for things you'll watch repeatedly.

### Breakpoints
- `set_breakpoint(file, line, condition?, hitCondition?, logMessage?)` — `file` is an absolute path, `line` is 1-based.
- `toggle_breakpoint(file, line)` — flip a breakpoint on/off.
- `remove_breakpoint(id)`, `clear_all_breakpoints`, `get_all_breakpoints`, `get_breakpoint(id)`.

### Terminals (captured via shell integration)
- `list_terminals`
- `read_terminal(idOrName, tail?)` — output captured per-command between `$ cmd` headers and `[exit N]` footers.
- `run_in_terminal(command, terminalName?, createIfMissing?)` — sends a command to an existing or new terminal; follow up with `read_terminal` to read output. *Prefer `run_task` over this for anything the user might want to re-run.*
- `clear_terminal_buffer(idOrName)`

### Debug console (the panel that shows your debug session's `console.log` etc.)
- `read_debug_console(tail?)` — output the running debug session has emitted.
- `eval_in_debug_console(expression, frameId?)` — REPL-style evaluation in the active session.
- `clear_debug_console_buffer`

## Standard playbooks

### "Run this and see what happens" / "Start the app"

Goal: hand the user a session they can interact with.

1. `list_launch_configurations` → does a config match what they want?
   - **Yes:** `start_debugging(name)`. Done. Watch progress via `read_debug_console`.
   - **No, but a task fits:** `list_tasks` → `run_task(name)`. Use this for dev servers, watchers, build pipelines.
   - **Neither exists:** Look at the project (package.json scripts, Cargo.toml binaries, etc.) and propose a launch config. Show the user the JSON, write it to `.vscode/launch.json` after their OK, then `start_debugging`.

### "This test/program is failing — figure out why"

1. `list_launch_configurations` to find a config that runs the failing scenario (or create one as above).
2. Identify the line(s) where you suspect the bug. **Read source first** (`Read`, `Grep`) — form a hypothesis before setting breakpoints. Shotgun breakpoints waste round-trips.
3. `set_breakpoint` at the most informative line — usually just before the suspected failure, or at the function entry of the misbehaving function.
4. `start_debugging` with that configuration.
5. When it pauses: `get_threads` → pick the paused thread → `get_stack_trace(threadId)`.
6. `get_scopes(frameId)` on the frame at the breakpoint → `get_variables(variablesReference)` on **Local** first. Only descend into variables that look suspicious — don't expand every reference, it's noisy.
7. `evaluate_expression` to test hypotheses (e.g. `evaluate_expression("user.permissions.length")`). **Avoid expressions with side effects** — they mutate the program you're debugging.
8. `step_over` / `step_in` only as needed. Each step is a round-trip; don't step blindly. If you know where to look next, `set_breakpoint` there and `continue_execution`.
9. When done: `stop_debugging` and `clear_all_breakpoints` for throwaway ones.

### "Run my dev server / start the watcher"

1. `list_tasks` to find their task (commonly named "dev", "watch", "start", or the npm script name).
2. `run_task(name, source?)` — `source` disambiguates duplicates.
3. The task's terminal opens in VS Code. The user can see it, type in it, and stop it from the task panel.
4. To read output: `list_terminals` → `read_terminal`. (Note: only commands run via shell integration are captured cleanly — some tasks with custom executors may not be.)
5. Don't `Bash npm start &` as an alternative. Backgrounded Bash processes get orphaned between tool calls and the user can't see them.

### "Reproduce a bug the user is seeing"

1. `list_terminals` → `read_terminal(idOrName)` to see what they're already seeing.
2. To re-run with debugging: pick the matching launch config (or create one), then follow the failure-investigation playbook above.

### "Stack trace from a log — where in the code is this?"

1. **Don't start debugging just to map a frame to source.** Use `Read` and `Grep` first.
2. Only start a debug session if the bug isn't obvious from the code and you need runtime values.

## Gotchas

- **Breakpoints want absolute paths.** Relative paths usually still resolve but absolute is unambiguous. Convert before calling `set_breakpoint`.
- **`variablesReference` is per-session.** Don't reuse references across sessions or after `continue_execution` — they're invalidated.
- **Never `evaluate_expression` with side effects.** Calling functions that mutate state corrupts what you're debugging. If you really need a side-effecting call, tell the user first.
- **Terminal capture needs shell integration.** If `read_terminal` returns an empty buffer, the user's shell may not have integration active. They can verify by looking for the prompt decoration gutter marks next to commands in VS Code's terminal.
- **The debug console buffer is cumulative across sessions** until cleared. If the user starts a new session and asks about its output, consider `clear_debug_console_buffer` first.
- **Don't dump the whole variable tree.** When `get_variables` returns 200 entries, summarize or filter — don't paste it all into your reply.
- **One active session at a time** is what `start_debugging`/stepping tools target. If the user has multiple debug sessions, ask which they mean.
- **Prefer creating a launch config over inventing flags inside `start_debugging`.** The config lives in `.vscode/launch.json`, so the user can re-run from VS Code's UI later without you.

## What success looks like

A good debug-MCP interaction:
- Hands the user a session they can drive — they see what's happening, you both read from the same screen
- One or two breakpoints in the right places, not ten in hopeful ones
- A clear narrative back to the user: "I paused at line 42 in `processOrder`. `order.items` was empty even though the input had 3 items. Stepping back, `parseInput` is silently dropping items when the JSON has trailing commas."
- Throwaway breakpoints cleared and the session stopped when done

If you find yourself stepping line-by-line through unfamiliar code, stop and re-read the source — the debugger is for confirming hypotheses, not for code reading.
