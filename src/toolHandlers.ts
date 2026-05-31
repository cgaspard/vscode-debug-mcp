import * as vscode from 'vscode';
import { CaptureManager } from './capture';
import { debugOps } from './debugOps';
import { listTasks, runTask, listRunningTasks, stopTask } from './tasks';

// One source of truth for all tool implementations. The MCP server
// (mcpServer.ts, via the per-window UDS listener in udsServer.ts) and the
// VS Code Language Model tools (lmTools.ts) both dispatch to these.
//
// Tools that mutate or read live VS Code state run inside the window that
// owns this extension host — which is exactly where each window's socket
// lives, so there is no cross-window routing to arrange.

export type Tool = (args: any) => Promise<unknown> | unknown;

export function buildLocalToolHandlers(capture: CaptureManager): Record<string, Tool> {
  return {
    // Launch / sessions
    list_launch_configurations: () => debugOps.listConfigurations(),
    start_debugging: ({ name, workspaceFolder }) => debugOps.start(name, workspaceFolder),
    stop_debugging: () => debugOps.stop(),
    continue_execution: async ({ threadId }) => {
      await debugOps.continue(threadId);
      return { ok: true };
    },
    pause_execution: async ({ threadId }) => {
      await debugOps.pause(threadId);
      return { ok: true };
    },
    step_over: async ({ threadId }) => {
      await debugOps.stepOver(threadId);
      return { ok: true };
    },
    step_in: async ({ threadId }) => {
      await debugOps.stepIn(threadId);
      return { ok: true };
    },
    step_out: async ({ threadId }) => {
      await debugOps.stepOut(threadId);
      return { ok: true };
    },

    // State inspection
    get_threads: () => debugOps.getThreads(),
    get_stack_trace: ({ threadId, levels }) => debugOps.getStackTrace(threadId, levels ?? 20),
    get_scopes: ({ frameId }) => debugOps.getScopes(frameId),
    get_variables: ({ variablesReference }) => debugOps.getVariables(variablesReference),
    evaluate_expression: ({ expression, frameId, context }) =>
      debugOps.evaluate(expression, frameId, context),

    // Breakpoints
    get_all_breakpoints: () => debugOps.getAllBreakpoints(),
    get_breakpoint: ({ id }) => debugOps.getBreakpoint(id) ?? null,
    set_breakpoint: ({ file, line, condition, hitCondition, logMessage }) =>
      debugOps.setBreakpoint(file, line, { condition, hitCondition, logMessage }),
    remove_breakpoint: ({ id }) => ({ removed: debugOps.removeBreakpoint(id) }),
    clear_all_breakpoints: () => {
      debugOps.clearAllBreakpoints();
      return { ok: true };
    },
    toggle_breakpoint: ({ file, line }) => debugOps.toggleBreakpoint(file, line),

    // Tasks
    list_tasks: () => listTasks(),
    run_task: ({ name, source }) => runTask(name, source),
    list_running_tasks: () => listRunningTasks(),
    stop_task: ({ name, source }) => stopTask(name, source),

    // Terminals
    list_terminals: () => capture.listTerminals(),
    read_terminal: ({ idOrName, tail }) => {
      const r = capture.readTerminal(idOrName, tail);
      if (!r) throw new Error(`No captured terminal found for "${idOrName}"`);
      return r;
    },
    clear_terminal_buffer: ({ idOrName }) => ({ cleared: capture.clearTerminal(idOrName) }),
    run_in_terminal: ({ command, terminalName, createIfMissing }) => {
      let terminal: vscode.Terminal | undefined;
      if (terminalName) {
        terminal = vscode.window.terminals.find((t) => t.name === terminalName);
        if (!terminal && (createIfMissing ?? true)) {
          terminal = vscode.window.createTerminal(terminalName);
        }
      } else {
        terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal('MCP');
      }
      if (!terminal) throw new Error(`Terminal "${terminalName}" not found.`);
      terminal.show(true);
      terminal.sendText(command, true);
      return { terminal: terminal.name };
    },

    // Sessions (user-started OR AI-started)
    list_debug_sessions: () => debugOps.listSessions(),
    get_last_stopped_event: ({ sessionId, levels }: { sessionId?: string; levels?: number } = {}) =>
      debugOps.getLastStoppedEvent(sessionId, levels ?? 5),

    // Debug console
    read_debug_console: ({ tail }) => ({ lines: capture.readDebugConsole(tail) }),
    clear_debug_console_buffer: () => {
      capture.clearDebugConsole();
      return { ok: true };
    },
    eval_in_debug_console: ({ expression, frameId }) =>
      debugOps.evaluate(expression, frameId, 'repl')
  };
}
