import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// Bundled at build time; esbuild inlines the JSON.
import { version as PACKAGE_VERSION } from '../package.json';

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true
  };
}

/** Workspace identity for the single window this server serves. */
export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
}

/**
 * The shape the MCP server expects from its hosting environment. There is no
 * cross-window routing any more: each VS Code window runs its own server and
 * every dispatch resolves locally. The workspaceId argument is vestigial and
 * always ignored — kept only so the dispatch signature stays stable.
 */
export interface MCPServerEnv {
  dispatch(workspaceId: string | undefined, tool: string, args: any): Promise<unknown>;
  listWorkspaces(): WorkspaceInfo[];
  defaultWorkspaceId(): string;
}

/**
 * Build the MCP server for this window. `sessionWorkspace`/`sessionId` are
 * accepted for call-site compatibility but unused — there is nothing to demux
 * in the single-window model.
 */
export function buildMcpServer(env: MCPServerEnv, _sessionWorkspace?: Map<string, string>, _sessionId?: () => string | undefined): McpServer {
  const server = new McpServer(
    { name: 'vscode-debug-mcp', version: PACKAGE_VERSION },
    { capabilities: { tools: {}, logging: {} } }
  );

  // Every tool dispatches to the local window.
  const forwarded = (
    name: string,
    description: string,
    schema: z.ZodRawShape
  ) => {
    (server.tool as any)(name, description, schema, async (args: any) => {
      try {
        const result = await env.dispatch(undefined, name, args);
        return jsonResult(result ?? { ok: true });
      } catch (err) {
        return errorResult(err);
      }
    });
  };

  // ---------- Tools ----------
  // Sessions (covers BOTH user-started and AI-started sessions)
  forwarded(
    'list_debug_sessions',
    'List every active or recently-terminated debug session in the bound workspace — including sessions the user started themselves via F5. Each entry has { id, name, type, status: running|paused|terminated, isActive, startedAt, lastStopped? }. lastStopped, when present, includes the frame and stack-trace snapshot from the most recent pause (preserved even after the user continues execution). Call this FIRST when a user mentions runtime behavior, errors, or debugging — they may already have a session paused at a breakpoint you should look at instead of starting your own.',
    {}
  );
  forwarded(
    'get_last_stopped_event',
    'Get a detailed snapshot of the most recent stopped event for a debug session (defaults to the active session, or the most recently paused one if no active session). Returns { reason, threadId, frame: { name, file, line, column }, stackTrace[] }. Survives the user continuing execution — even if the session is no longer paused, you can still read where it last stopped. Use this when joining a chat where the user already has (or had) a debug session in progress.',
    {
      sessionId: z.string().optional().describe('Session id from list_debug_sessions. Omit to use the active or most-recently-paused session.'),
      levels: z.number().int().min(1).max(50).optional().describe('Max stack frames to include (default 5).')
    }
  );

  // Launch / sessions
  forwarded('list_launch_configurations', 'List debug configurations defined in launch.json across workspace folders.', {});
  forwarded('start_debugging', 'Start a debug session by launch.json configuration name. Omit name to use the workspace default.', {
    name: z.string().optional().describe('Configuration name from launch.json'),
    workspaceFolder: z.string().optional().describe('Workspace folder name (optional)')
  });
  forwarded('stop_debugging', 'Stop the active debug session.', {});
  forwarded('continue_execution', 'Continue execution in the active debug session.', { threadId: z.number().int().optional() });
  forwarded('pause_execution', 'Pause execution in the active debug session.', { threadId: z.number().int().optional() });
  forwarded('step_over', 'Step over the current statement.', { threadId: z.number().int().optional() });
  forwarded('step_in', 'Step into the next function call.', { threadId: z.number().int().optional() });
  forwarded('step_out', 'Step out of the current function.', { threadId: z.number().int().optional() });

  // State inspection
  forwarded('get_threads', 'List threads in the active debug session.', {});
  forwarded('get_stack_trace', 'Get the stack trace for a thread (defaults to first thread).', {
    threadId: z.number().int().optional(),
    levels: z.number().int().min(1).max(200).optional()
  });
  forwarded('get_scopes', 'Get scopes for a stack frame.', { frameId: z.number().int() });
  forwarded('get_variables', 'Get variables for a given variablesReference.', { variablesReference: z.number().int() });
  forwarded('evaluate_expression', 'Evaluate an expression in the active debug session.', {
    expression: z.string(),
    frameId: z.number().int().optional(),
    context: z.enum(['watch', 'repl', 'hover']).optional()
  });

  // Breakpoints
  forwarded('get_all_breakpoints', 'List all breakpoints.', {});
  forwarded('get_breakpoint', 'Get a breakpoint by ID.', { id: z.string() });
  forwarded('set_breakpoint', 'Add a source breakpoint at file/line. Line is 1-based.', {
    file: z.string(),
    line: z.number().int().min(1),
    condition: z.string().optional(),
    hitCondition: z.string().optional(),
    logMessage: z.string().optional()
  });
  forwarded('remove_breakpoint', 'Remove a breakpoint by ID.', { id: z.string() });
  forwarded('clear_all_breakpoints', 'Remove all breakpoints.', {});
  forwarded('toggle_breakpoint', 'Toggle a source breakpoint at the given file/line (1-based).', {
    file: z.string(),
    line: z.number().int().min(1)
  });

  // Tasks
  forwarded('list_tasks', 'List all tasks visible to VS Code (workspace + extensions).', {});
  forwarded('run_task', 'Run a VS Code task by name. Provide source to disambiguate if multiple tasks share a name.', {
    name: z.string(),
    source: z.string().optional()
  });
  forwarded('list_running_tasks', 'List currently executing tasks.', {});
  forwarded('stop_task', 'Terminate running task(s) by name (optionally filtered by source).', {
    name: z.string(),
    source: z.string().optional()
  });

  // Terminals
  forwarded('list_terminals', 'List terminals being captured via shell integration.', {});
  forwarded('read_terminal', 'Read captured output from a terminal by id or name.', {
    idOrName: z.string(),
    tail: z.number().int().min(1).max(10000).optional()
  });
  forwarded('clear_terminal_buffer', 'Clear the captured buffer for a terminal.', { idOrName: z.string() });
  forwarded('run_in_terminal', 'Send a command to a terminal.', {
    command: z.string(),
    terminalName: z.string().optional(),
    createIfMissing: z.boolean().optional()
  });

  // Debug console
  forwarded('read_debug_console', 'Read captured output from the debug console.', {
    tail: z.number().int().min(1).max(10000).optional()
  });
  forwarded('clear_debug_console_buffer', 'Clear the captured debug console buffer.', {});
  forwarded('eval_in_debug_console', 'Evaluate an expression in the debug console (REPL).', {
    expression: z.string(),
    frameId: z.number().int().optional()
  });

  return server;
}
