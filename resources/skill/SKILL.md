---
name: debug-mcp
description: Use this skill when the user is debugging a running program, investigating a crash, looking into why something is failing at runtime, reproducing a bug, stepping through code execution, inspecting state in a paused program, or asking questions that depend on values at runtime rather than static code. Provides guidance for driving the VS Code Debug MCP server's tools (start_debugging, breakpoints, stack/scope/variables, run_task, read_terminal, read_debug_console).
---

# Debug MCP — how to use the VS Code Debug MCP tools

This skill is for the [`vscode-debug-mcp`](https://github.com/cgaspard/vscode-debug-mcp) VS Code extension, which exposes the active VS Code session over MCP. The tools below all run *inside* the user's live VS Code — every action (a breakpoint, a task run, a step) is visible to the user in their editor.

## When to reach for these tools

**Use them when:**
- The user is investigating a runtime bug, crash, or unexpected behavior
- A test or program is failing and the root cause isn't obvious from reading the code
- The user asks "what is the value of X when …" or "where does control flow go when …"
- The user wants to step through code or set a breakpoint
- You need terminal/console output from a command the user ran in VS Code

**Don't use them for:**
- Static code review, refactoring, or syntax questions
- Reading files (use Read instead — much cheaper)
- Running build/lint commands when you don't need to observe live output (Bash is fine)
- Speculative "let me explore the codebase" work — these tools are for live state, not source exploration

The tools cost more than reading source code, both in latency and in disturbing the user's editor. Default to static analysis; reach for the debugger when you need runtime truth.

## Tool catalog

### Launch & sessions
- `list_launch_configurations` — what's in `launch.json`. Use first to learn what configurations exist before asking the user
- `start_debugging(name?, workspaceFolder?)` — start a session by name. Omit `name` for VS Code's default
- `stop_debugging` — terminate the active session
- `continue_execution`, `pause_execution`, `step_over`, `step_in`, `step_out` — execution control. All take optional `threadId`; omit to use the first thread

### State inspection (only meaningful while paused)
- `get_threads` — usually one in a normal program, more in multithreaded code
- `get_stack_trace(threadId?, levels?)` — frames from top of stack down
- `get_scopes(frameId)` — what's in scope at a frame (Local, Closure, Global)
- `get_variables(variablesReference)` — expand a scope or a parent variable. References are returned by `get_scopes` and by other variables; they're not stable across sessions
- `evaluate_expression(expression, frameId?, context?)` — evaluate in the paused context. `context: 'repl'` (default) for one-offs, `'watch'` for things you'll watch

### Breakpoints
- `set_breakpoint(file, line, condition?, hitCondition?, logMessage?)` — `file` is an absolute path, `line` is 1-based
- `toggle_breakpoint(file, line)` — flip a breakpoint on/off
- `remove_breakpoint(id)`, `clear_all_breakpoints`, `get_all_breakpoints`, `get_breakpoint(id)`

### Tasks (`tasks.json` + extension-contributed)
- `list_tasks` — all tasks visible to VS Code
- `run_task(name, source?)` — execute by name. `source` disambiguates when multiple tasks share a name (e.g. `"Workspace"` vs `"npm"`)
- `list_running_tasks`, `stop_task(name, source?)`

### Terminals (captured via shell integration)
- `list_terminals`
- `read_terminal(idOrName, tail?)` — output is captured per-command between `$ cmd` headers and `[exit N]` footers
- `run_in_terminal(command, terminalName?, createIfMissing?)` — sends a command; follow up with `read_terminal` to read output
- `clear_terminal_buffer(idOrName)`

### Debug console
- `read_debug_console(tail?)` — output emitted by `console.log` / equivalent during debug sessions
- `eval_in_debug_console(expression, frameId?)` — REPL-style evaluation in the active session
- `clear_debug_console_buffer`

## Standard playbooks

### "This test/program is failing — figure out why"
1. `list_launch_configurations` to find a config that runs the failing scenario. If none exists, ask the user.
2. Identify the line(s) where you suspect the bug. Read the source first (`Read`, `Grep`) to form a hypothesis — don't shotgun breakpoints.
3. `set_breakpoint` at the most informative line (usually just before the suspected failure, or at the function entry of the function that's misbehaving).
4. `start_debugging` with the right configuration name.
5. When it hits: `get_threads` → pick the paused thread → `get_stack_trace(threadId)`.
6. `get_scopes(frameId)` on the frame at the breakpoint → `get_variables(variablesReference)` on Local first. Only descend into variables that look suspicious. Don't expand every reference — it's noisy.
7. `evaluate_expression` to test hypotheses (e.g., `evaluate_expression("user.permissions.length")`). Avoid expressions with side effects.
8. `step_over` / `step_in` only as needed. Each step is a round-trip; don't step blindly. If you know where to look next, set another breakpoint and `continue_execution` instead.
9. When done: `stop_debugging` and `clear_all_breakpoints` if you created throwaway ones.

### "Reproduce a bug the user is seeing in the terminal"
1. `list_terminals` to find their terminal (or have them run the command, then `list_terminals`).
2. `read_terminal(idOrName)` to see what they saw.
3. If you need to re-run with debugging: identify the failing command, find/create a matching launch config, then follow the playbook above.

### "Stack trace from a log — where in the code is this?"
1. Don't start debugging just to map a stack frame to source. Use `Read` and `Grep` on the source first.
2. Only start a debug session if the bug isn't obvious from the code and you need runtime values.

### "Run a build/test task and watch the output"
1. `list_tasks` to find the task.
2. `run_task(name, source?)` — `source` is needed when multiple tasks share a name.
3. The task's output appears in a VS Code terminal. `list_terminals` → `read_terminal` to read it. (Note: only commands run *via shell integration* are captured — tasks using a custom executor may not be.)
4. `list_running_tasks` to see what's running; `stop_task` to terminate.

## Gotchas

- **Breakpoints want absolute paths.** Relative paths usually still work but absolute is unambiguous. Convert before calling `set_breakpoint`.
- **`variablesReference` is per-session.** Don't reuse it across sessions or after `continue_execution`.
- **Don't `evaluate_expression` with side effects.** Calling functions that mutate state changes the program you're debugging. If you need a side-effecting call, tell the user what you're about to do.
- **Terminal capture requires shell integration.** If `read_terminal` returns an empty buffer, the user's shell may not have integration active. They can verify by looking for the "command decoration" gutter marks next to their prompts in VS Code.
- **The debug console buffer is cumulative across sessions** until cleared. If the user starts a new session and asks about its output, consider `clear_debug_console_buffer` first.
- **Don't dump the whole variable tree.** When `get_variables` returns 200 entries, summarize or filter — don't paste all of it into your reply.
- **One session at a time.** `vscode.debug.activeDebugSession` is whichever was started most recently. If the user has multiple debug sessions, ask which one before stepping.

## What success looks like

A good debug-MCP interaction is short and pointed:
- One or two breakpoints in the right places, not ten in hopeful ones
- A clear narrative back to the user: "I paused at line 42 in `processOrder`. At that point, `order.items` was empty even though the input had 3 items. Stepping back, `parseInput` is silently dropping items when the JSON has trailing commas. Fix: …"
- The session is stopped and throwaway breakpoints are cleared when you're done

If you find yourself stepping line-by-line through unfamiliar code, stop and re-read the source instead — debugging is for confirming hypotheses, not for code reading.
