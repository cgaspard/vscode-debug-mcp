---
name: debug-mcp
description: Use this skill when the user is debugging a running program, investigating a crash, looking into why something is failing at runtime, reproducing a bug, stepping through code execution, inspecting state in a paused program, asking questions that depend on values at runtime, or asking you to "run" something they want to interact with. Provides guidance for driving the VS Code Debug MCP server's tools — including the common case where the user already has a debug session paused at a breakpoint that you should look at FIRST before doing anything else.
---

# Debug MCP — driving VS Code from your tool calls

This skill is for the [`vscode-debug-mcp`](https://github.com/cgaspard/vscode-debug-mcp) extension. The tools below run *inside* the user's live VS Code window — every action (a breakpoint, a task run, a step) is visible to the user, and the user is a participant in the session, not a spectator.

## ⚠ FIRST RULE: Check for an existing session before doing anything

Most debugging conversations start with the **user already debugging**. They hit F5, hit a breakpoint, walked over to Claude/Copilot to ask a question. They expect you to look at *their* paused program, not start your own.

**Before you do anything else when the conversation involves runtime behavior, runtime values, a crash, an unexpected exception, or "why is X happening":**

```
1. list_debug_sessions
2. If any session has status "paused" or has a recent lastStopped:
     get_last_stopped_event(sessionId)   ← read the stopped frame + stack
     → answer using THIS context, do NOT start a new session
3. If no session is paused but there's a running session:
     → the program is mid-execution; you may want to set a breakpoint
       and let it hit, rather than starting another session
4. Only if NO session exists, consider starting one (see "Starting from scratch" below)
```

Skipping this step is the #1 mistake. If the user is mid-debug and you start a *second* session, you fork their workflow and confuse them.

### What `list_debug_sessions` returns

Each entry has:
- `id` — opaque session id, pass to `get_last_stopped_event(sessionId)` etc.
- `name` — the launch.json configuration name (e.g. "Launch Sample App")
- `type` — debugger type (`node`, `python`, `cppdbg`, …)
- `status` — `starting`, `running`, `paused`, `terminated`
- `isActive` — true if this is VS Code's current focused session
- `lastStopped` — present if the session has paused at least once. Contains `reason` (`breakpoint`, `exception`, `step`, `pause`, `entry`), `threadId`, and a captured `frame`/`stackTrace` snapshot. **This snapshot is preserved even after the user continues execution**, so you can still see where they were last paused.

### What `get_last_stopped_event` gives you

A richer snapshot of the most recent pause for a session: `{ reason, threadId, frame: { name, file, line, column }, stackTrace: [...] }`. If the session is still paused right now, it's a live snapshot. If the user has already continued, you get the snapshot from when they were last paused — usually still exactly what you need to answer "why did it stop here?"

## Tools, by use case

### The session you're working with
- **`list_debug_sessions`** — see what's happening. Call first.
- **`get_last_stopped_event(sessionId?, levels?)`** — read where execution stopped most recently, with stack trace.

### Inspect runtime state (the session must be paused)
- `get_threads` — list threads in the active session.
- `get_stack_trace(threadId?, levels?)` — frames from top of stack down. Defaults to the first thread.
- `get_scopes(frameId)` — Local / Closure / Global at a frame.
- `get_variables(variablesReference)` — expand a scope or a parent variable. References come from `get_scopes` and other variables; not stable across `continue_execution` or sessions.
- `evaluate_expression(expression, frameId?, context?)` — evaluate in the paused context. `context: 'repl'` (default) for one-offs.

### Drive the session
- `continue_execution`, `pause_execution`, `step_over`, `step_in`, `step_out` — all take optional `threadId`.
- `stop_debugging` — terminate the active session.

### Breakpoints
- `get_all_breakpoints`, `get_breakpoint(id)`
- `set_breakpoint(file, line, condition?, hitCondition?, logMessage?)` — `file` is an absolute path, `line` is 1-based.
- `toggle_breakpoint(file, line)`, `remove_breakpoint(id)`, `clear_all_breakpoints`

### Start a session (only when no session exists)
- `list_launch_configurations` — what's in launch.json. Use first.
- `start_debugging(name?, workspaceFolder?)` — start a session by config name.

### Tasks (long-running processes, build/test/dev-server)
- `list_tasks`, `run_task(name, source?)`, `list_running_tasks`, `stop_task(name, source?)`

### Terminals (captured via shell integration)
- `list_terminals`, `read_terminal(idOrName, tail?)`, `run_in_terminal(command, terminalName?)`

### Debug console
- `read_debug_console(tail?)` — output emitted by the running session's `console.log`/equivalent.
- `eval_in_debug_console(expression, frameId?)` — REPL-style evaluation.

## Playbooks

### "I'm paused at a breakpoint, why is X happening?"

**Most common scenario.** The user hit F5, ran into a breakpoint, came to chat.

1. `list_debug_sessions` — confirm there's a `paused` session.
2. `get_last_stopped_event` — read where they stopped, with stack trace.
3. The frame field tells you the file/line. Read source around there with `Read` for context.
4. `get_threads` → `get_scopes(frameId)` → `get_variables(variablesReference)` for Local scope. Don't dump every variable; focus on what's relevant to the user's question.
5. `evaluate_expression` to test hypotheses. **Never evaluate side-effecting expressions** — they mutate the paused program.
6. If needed, set new breakpoints with `set_breakpoint` and `continue_execution`. Step only when you don't know where to set the next breakpoint.

### "My program crashed / threw an exception"

1. `list_debug_sessions` — exception breakpoints usually leave the session in a `paused` state with `lastStopped.reason === 'exception'`.
2. If found: `get_last_stopped_event` for the frame + stack at the throw site.
3. If the session has terminated, check `read_debug_console` for the trace it logged.
4. If no debug session was running, ask the user to enable "Uncaught Exceptions" in VS Code's debug breakpoints panel and re-run.

### "Run this and let me debug it"

1. `list_debug_sessions` to make sure nothing's already running you'd clash with.
2. `list_launch_configurations` to find a matching config.
3. If a config matches: `start_debugging(name)`. Done. The user now has a real interactive session.
4. If no config matches, propose one. Show the user the launch.json entry, get OK, write it, then `start_debugging`.

### "Run the dev server / watcher / build pipeline"

Not a debug session — use tasks instead.

1. `list_tasks` to find their task.
2. `run_task(name, source?)`. The task's output appears in a VS Code terminal that the user can see and stop from the task panel.
3. `read_terminal` to pull output. Don't `Bash npm start &` — backgrounded shell processes get orphaned.

## Gotchas

- **`list_debug_sessions` is your first call.** If you skip it and the user is mid-debug, you'll either start a redundant session or talk past them.
- **`lastStopped` survives `continue_execution`.** You can still read where the user was last paused even if they're running again now. The frame and stack snapshot was captured at pause time.
- **Breakpoints want absolute paths.** Relative paths usually still resolve but absolute is unambiguous.
- **`variablesReference` is per-session and per-pause.** Don't reuse after `continue_execution` or across sessions.
- **Never `evaluate_expression` with side effects.** Mutating function calls corrupt the program you're debugging. If you really must, tell the user first.
- **Terminal capture requires shell integration.** If `read_terminal` returns nothing, the user's shell may not have it active. Look for the prompt decoration gutter marks in VS Code's terminal.
- **`vscode.debug.activeDebugSession` ≠ "the session you care about".** When the user has multiple sessions, the "active" one is whichever they last focused, not necessarily the one they're asking about. Read session ids from `list_debug_sessions` instead of assuming.
- **Prefer launch configs over flags.** When proposing a new launch, write it to `.vscode/launch.json` so the user can re-run from VS Code's UI later — don't smuggle args into `start_debugging`.

## What success looks like

A good interaction starts with **looking at what the user is already doing** instead of starting fresh. After two tool calls (`list_debug_sessions`, `get_last_stopped_event`), you should know:

- Whether a session is running, paused, or recently stopped
- What file/line/frame the user was last paused at
- What kind of stop it was (breakpoint vs exception)

From there: read the relevant source, look at locals if needed, evaluate one or two expressions to confirm your hypothesis, narrate back. One or two breakpoints in the right places. Not ten in hopeful ones.

If you find yourself stepping line-by-line through unfamiliar code, stop — the debugger is for confirming hypotheses formed by reading source, not for code exploration.
