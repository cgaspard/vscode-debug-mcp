import * as vscode from 'vscode';
import { CaptureManager } from './capture';
import { debugOps } from './debugOps';
import { listTasks, runTask, listRunningTasks, stopTask } from './tasks';

// Language Model Tools API integration — exposes the same capabilities
// as the MCP server to Copilot Chat (agent mode) and any other consumer
// of vscode.lm.
//
// Each registered tool MUST also be declared in package.json under
// contributes.languageModelTools with a matching name.

type Stringy = string | number | boolean | null;

function textPart(value: unknown): vscode.LanguageModelTextPart {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return new vscode.LanguageModelTextPart(text);
}

function result(value: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([textPart(value)]);
}

interface ToolDef<I> {
  name: string;
  handler: (input: I, token: vscode.CancellationToken) => Promise<unknown> | unknown;
  // If provided, the tool requires confirmation before being invoked.
  // The function returns the user-facing confirmation message; if it
  // returns undefined, no confirmation is shown.
  confirm?: (input: I) => { title: string; message: vscode.MarkdownString } | undefined;
  // Optional one-line summary shown while invoking ("Running task: build").
  invocationMessage?: (input: I) => string;
}

function defineTool<I>(def: ToolDef<I>): vscode.Disposable {
  const tool: vscode.LanguageModelTool<I> = {
    async invoke(options, token) {
      try {
        const value = await def.handler(options.input, token);
        return result(value ?? { ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return result({ error: message });
      }
    },
    async prepareInvocation(options) {
      const out: vscode.PreparedToolInvocation = {};
      if (def.invocationMessage) {
        out.invocationMessage = def.invocationMessage(options.input);
      }
      if (def.confirm) {
        const c = def.confirm(options.input);
        if (c) out.confirmationMessages = c;
      }
      return out;
    }
  };
  return vscode.lm.registerTool<I>(def.name, tool);
}

export function registerLmTools(context: vscode.ExtensionContext, capture: CaptureManager): void {
  const subs: vscode.Disposable[] = [];

  // ---------- Launch / sessions ----------
  subs.push(
    defineTool<{}>({
      name: 'debugMcp_list_launch_configurations',
      handler: () => debugOps.listConfigurations(),
      invocationMessage: () => 'Listing launch.json configurations'
    })
  );

  subs.push(
    defineTool<{ name?: string; workspaceFolder?: string }>({
      name: 'debugMcp_start_debugging',
      handler: ({ name, workspaceFolder }) => debugOps.start(name, workspaceFolder),
      invocationMessage: ({ name }) => `Starting debug session: ${name ?? '(default)'}`,
      confirm: ({ name }) => ({
        title: 'Start debug session',
        message: new vscode.MarkdownString(
          `Start the debug session **${name ?? '(workspace default)'}** from \`launch.json\`?`
        )
      })
    })
  );

  subs.push(
    defineTool<{}>({
      name: 'debugMcp_stop_debugging',
      handler: () => debugOps.stop(),
      invocationMessage: () => 'Stopping active debug session',
      confirm: () => ({
        title: 'Stop debug session',
        message: new vscode.MarkdownString('Terminate the active debug session?')
      })
    })
  );

  subs.push(
    defineTool<{ threadId?: number }>({
      name: 'debugMcp_continue_execution',
      handler: async ({ threadId }) => {
        await debugOps.continue(threadId);
        return { ok: true };
      },
      invocationMessage: () => 'Continuing execution'
    })
  );

  subs.push(
    defineTool<{ threadId?: number }>({
      name: 'debugMcp_step_over',
      handler: async ({ threadId }) => {
        await debugOps.stepOver(threadId);
        return { ok: true };
      },
      invocationMessage: () => 'Stepping over'
    })
  );

  subs.push(
    defineTool<{ threadId?: number }>({
      name: 'debugMcp_step_in',
      handler: async ({ threadId }) => {
        await debugOps.stepIn(threadId);
        return { ok: true };
      },
      invocationMessage: () => 'Stepping in'
    })
  );

  subs.push(
    defineTool<{ threadId?: number }>({
      name: 'debugMcp_step_out',
      handler: async ({ threadId }) => {
        await debugOps.stepOut(threadId);
        return { ok: true };
      },
      invocationMessage: () => 'Stepping out'
    })
  );

  // ---------- State inspection (read-only) ----------
  subs.push(defineTool<{}>({ name: 'debugMcp_get_threads', handler: () => debugOps.getThreads() }));
  subs.push(
    defineTool<{ threadId?: number; levels?: number }>({
      name: 'debugMcp_get_stack_trace',
      handler: ({ threadId, levels }) => debugOps.getStackTrace(threadId, levels ?? 20)
    })
  );
  subs.push(
    defineTool<{ frameId: number }>({
      name: 'debugMcp_get_scopes',
      handler: ({ frameId }) => debugOps.getScopes(frameId)
    })
  );
  subs.push(
    defineTool<{ variablesReference: number }>({
      name: 'debugMcp_get_variables',
      handler: ({ variablesReference }) => debugOps.getVariables(variablesReference)
    })
  );
  subs.push(
    defineTool<{ expression: string; frameId?: number; context?: 'watch' | 'repl' | 'hover' }>({
      name: 'debugMcp_evaluate_expression',
      handler: ({ expression, frameId, context }) => debugOps.evaluate(expression, frameId, context),
      confirm: ({ expression }) => ({
        title: 'Evaluate in debug session',
        message: new vscode.MarkdownString(
          `Evaluate \`${expression}\` in the active debug session?\n\n*Be wary of side-effecting expressions — they will mutate the running program.*`
        )
      })
    })
  );

  // ---------- Breakpoints ----------
  subs.push(defineTool<{}>({ name: 'debugMcp_get_all_breakpoints', handler: () => debugOps.getAllBreakpoints() }));
  subs.push(
    defineTool<{ file: string; line: number; condition?: string; hitCondition?: string; logMessage?: string }>({
      name: 'debugMcp_set_breakpoint',
      handler: ({ file, line, condition, hitCondition, logMessage }) =>
        debugOps.setBreakpoint(file, line, { condition, hitCondition, logMessage }),
      invocationMessage: ({ file, line }) => `Setting breakpoint at ${file}:${line}`
    })
  );
  subs.push(
    defineTool<{ id: string }>({
      name: 'debugMcp_remove_breakpoint',
      handler: ({ id }) => ({ removed: debugOps.removeBreakpoint(id) })
    })
  );
  subs.push(
    defineTool<{}>({
      name: 'debugMcp_clear_all_breakpoints',
      handler: () => {
        debugOps.clearAllBreakpoints();
        return { ok: true };
      },
      confirm: () => ({
        title: 'Clear all breakpoints',
        message: new vscode.MarkdownString('Remove **all** breakpoints in the current session?')
      })
    })
  );
  subs.push(
    defineTool<{ file: string; line: number }>({
      name: 'debugMcp_toggle_breakpoint',
      handler: ({ file, line }) => debugOps.toggleBreakpoint(file, line),
      invocationMessage: ({ file, line }) => `Toggling breakpoint at ${file}:${line}`
    })
  );

  // ---------- Tasks ----------
  subs.push(defineTool<{}>({ name: 'debugMcp_list_tasks', handler: () => listTasks() }));
  subs.push(
    defineTool<{ name: string; source?: string }>({
      name: 'debugMcp_run_task',
      handler: ({ name, source }) => runTask(name, source),
      invocationMessage: ({ name }) => `Running task: ${name}`,
      confirm: ({ name, source }) => ({
        title: 'Run VS Code task',
        message: new vscode.MarkdownString(
          `Run task **${name}**${source ? ` (source: \`${source}\`)` : ''}?`
        )
      })
    })
  );
  subs.push(defineTool<{}>({ name: 'debugMcp_list_running_tasks', handler: () => listRunningTasks() }));
  subs.push(
    defineTool<{ name: string; source?: string }>({
      name: 'debugMcp_stop_task',
      handler: ({ name, source }) => stopTask(name, source),
      invocationMessage: ({ name }) => `Stopping task: ${name}`,
      confirm: ({ name }) => ({
        title: 'Stop task',
        message: new vscode.MarkdownString(`Terminate the running task **${name}**?`)
      })
    })
  );

  // ---------- Terminals ----------
  subs.push(defineTool<{}>({ name: 'debugMcp_list_terminals', handler: () => capture.listTerminals() }));
  subs.push(
    defineTool<{ idOrName: string; tail?: number }>({
      name: 'debugMcp_read_terminal',
      handler: ({ idOrName, tail }) => {
        const r = capture.readTerminal(idOrName, tail);
        if (!r) throw new Error(`No captured terminal found for "${idOrName}"`);
        return r;
      }
    })
  );
  subs.push(
    defineTool<{ command: string; terminalName?: string; createIfMissing?: boolean }>({
      name: 'debugMcp_run_in_terminal',
      handler: ({ command, terminalName, createIfMissing }) => {
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
      invocationMessage: ({ command }) => `Running in terminal: ${command}`,
      confirm: ({ command, terminalName }) => ({
        title: 'Run command in terminal',
        message: new vscode.MarkdownString(
          `Run \`${command}\` in terminal **${terminalName ?? '(active/new)'}**?\n\nThis sends keystrokes to a VS Code terminal — review the command carefully.`
        )
      })
    })
  );

  // ---------- Debug console ----------
  subs.push(
    defineTool<{ tail?: number }>({
      name: 'debugMcp_read_debug_console',
      handler: ({ tail }) => ({ lines: capture.readDebugConsole(tail) })
    })
  );
  subs.push(
    defineTool<{ expression: string; frameId?: number }>({
      name: 'debugMcp_eval_in_debug_console',
      handler: ({ expression, frameId }) => debugOps.evaluate(expression, frameId, 'repl'),
      confirm: ({ expression }) => ({
        title: 'Evaluate in debug console',
        message: new vscode.MarkdownString(
          `Evaluate \`${expression}\` in the debug console REPL?\n\n*Side-effecting expressions will mutate the running program.*`
        )
      })
    })
  );

  for (const s of subs) context.subscriptions.push(s);
}
