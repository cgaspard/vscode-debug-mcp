import * as vscode from 'vscode';
import express, { type Request, type Response } from 'express';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { CaptureManager } from './capture';
import { debugOps } from './debugOps';
import { listTasks, runTask, listRunningTasks, stopTask } from './tasks';

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

function buildMcpServer(capture: CaptureManager): McpServer {
  const server = new McpServer(
    { name: 'vscode-debug-mcp', version: '0.1.0' },
    { capabilities: { tools: {}, logging: {} } }
  );

  const tool = (
    name: string,
    description: string,
    schema: z.ZodRawShape,
    handler: (args: any) => Promise<unknown> | unknown
  ) => {
    (server.tool as any)(name, description, schema, async (args: any) => {
      try {
        const result = await handler(args);
        return jsonResult(result ?? { ok: true });
      } catch (err) {
        return errorResult(err);
      }
    });
  };

  // ---------- Launch / sessions ----------
  tool('list_launch_configurations', 'List debug configurations defined in launch.json across workspace folders.', {}, async () => {
    return debugOps.listConfigurations();
  });

  tool(
    'start_debugging',
    'Start a debug session by launch.json configuration name. Omit name to use the workspace default.',
    {
      name: z.string().optional().describe('Configuration name from launch.json'),
      workspaceFolder: z.string().optional().describe('Workspace folder name (optional)')
    },
    async ({ name, workspaceFolder }) => debugOps.start(name, workspaceFolder)
  );

  tool('stop_debugging', 'Stop the active debug session.', {}, async () => debugOps.stop());

  tool('continue_execution', 'Continue execution in the active debug session.', { threadId: z.number().int().optional() }, async ({ threadId }) => {
    await debugOps.continue(threadId);
    return { ok: true };
  });

  tool('pause_execution', 'Pause execution in the active debug session.', { threadId: z.number().int().optional() }, async ({ threadId }) => {
    await debugOps.pause(threadId);
    return { ok: true };
  });

  tool('step_over', 'Step over the current statement.', { threadId: z.number().int().optional() }, async ({ threadId }) => {
    await debugOps.stepOver(threadId);
    return { ok: true };
  });

  tool('step_in', 'Step into the next function call.', { threadId: z.number().int().optional() }, async ({ threadId }) => {
    await debugOps.stepIn(threadId);
    return { ok: true };
  });

  tool('step_out', 'Step out of the current function.', { threadId: z.number().int().optional() }, async ({ threadId }) => {
    await debugOps.stepOut(threadId);
    return { ok: true };
  });

  // ---------- State inspection ----------
  tool('get_threads', 'List threads in the active debug session.', {}, async () => debugOps.getThreads());

  tool(
    'get_stack_trace',
    'Get the stack trace for a thread (defaults to first thread).',
    { threadId: z.number().int().optional(), levels: z.number().int().min(1).max(200).optional() },
    async ({ threadId, levels }) => debugOps.getStackTrace(threadId, levels ?? 20)
  );

  tool('get_scopes', 'Get scopes for a stack frame.', { frameId: z.number().int() }, async ({ frameId }) => debugOps.getScopes(frameId));

  tool(
    'get_variables',
    'Get variables for a given variablesReference (from a scope or parent variable).',
    { variablesReference: z.number().int() },
    async ({ variablesReference }) => debugOps.getVariables(variablesReference)
  );

  tool(
    'evaluate_expression',
    'Evaluate an expression in the active debug session.',
    {
      expression: z.string(),
      frameId: z.number().int().optional(),
      context: z.enum(['watch', 'repl', 'hover']).optional()
    },
    async ({ expression, frameId, context }) => debugOps.evaluate(expression, frameId, context)
  );

  // ---------- Breakpoints ----------
  tool('get_all_breakpoints', 'List all breakpoints.', {}, async () => debugOps.getAllBreakpoints());

  tool('get_breakpoint', 'Get a breakpoint by ID.', { id: z.string() }, async ({ id }) => debugOps.getBreakpoint(id) ?? null);

  tool(
    'set_breakpoint',
    'Add a source breakpoint at file/line. Line is 1-based.',
    {
      file: z.string(),
      line: z.number().int().min(1),
      condition: z.string().optional(),
      hitCondition: z.string().optional(),
      logMessage: z.string().optional()
    },
    async ({ file, line, condition, hitCondition, logMessage }) =>
      debugOps.setBreakpoint(file, line, { condition, hitCondition, logMessage })
  );

  tool('remove_breakpoint', 'Remove a breakpoint by ID.', { id: z.string() }, async ({ id }) => ({ removed: debugOps.removeBreakpoint(id) }));

  tool('clear_all_breakpoints', 'Remove all breakpoints.', {}, async () => {
    debugOps.clearAllBreakpoints();
    return { ok: true };
  });

  tool(
    'toggle_breakpoint',
    'Toggle a source breakpoint at the given file/line (1-based).',
    { file: z.string(), line: z.number().int().min(1) },
    async ({ file, line }) => debugOps.toggleBreakpoint(file, line)
  );

  // ---------- Tasks ----------
  tool('list_tasks', 'List all tasks visible to VS Code (workspace + extensions).', {}, async () => listTasks());

  tool(
    'run_task',
    'Run a VS Code task by name. Provide source to disambiguate if multiple tasks share a name (e.g. "Workspace", "npm").',
    { name: z.string(), source: z.string().optional() },
    async ({ name, source }) => runTask(name, source)
  );

  tool('list_running_tasks', 'List currently executing tasks.', {}, async () => listRunningTasks());

  tool(
    'stop_task',
    'Terminate running task(s) by name (optionally filtered by source).',
    { name: z.string(), source: z.string().optional() },
    async ({ name, source }) => stopTask(name, source)
  );

  // ---------- Terminals ----------
  tool('list_terminals', 'List terminals being captured via shell integration.', {}, async () => capture.listTerminals());

  tool(
    'read_terminal',
    'Read captured output from a terminal by id or name. Output is captured via shell integration, so each command produces a "$ command (exit N)" header followed by its output.',
    { idOrName: z.string(), tail: z.number().int().min(1).max(10000).optional() },
    async ({ idOrName, tail }) => {
      const r = capture.readTerminal(idOrName, tail);
      if (!r) throw new Error(`No captured terminal found for "${idOrName}"`);
      return r;
    }
  );

  tool(
    'clear_terminal_buffer',
    'Clear the captured buffer for a terminal (does not affect the terminal itself).',
    { idOrName: z.string() },
    async ({ idOrName }) => ({ cleared: capture.clearTerminal(idOrName) })
  );

  tool(
    'run_in_terminal',
    'Send a command to a terminal. If no terminal name is given, a new one is created. Use read_terminal afterwards to read output.',
    {
      command: z.string(),
      terminalName: z.string().optional(),
      createIfMissing: z.boolean().optional()
    },
    async ({ command, terminalName, createIfMissing }) => {
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
    }
  );

  // ---------- Debug console ----------
  tool(
    'read_debug_console',
    'Read captured output from the debug console (any active or recent debug session).',
    { tail: z.number().int().min(1).max(10000).optional() },
    async ({ tail }) => ({ lines: capture.readDebugConsole(tail) })
  );

  tool('clear_debug_console_buffer', 'Clear the captured debug console buffer.', {}, async () => {
    capture.clearDebugConsole();
    return { ok: true };
  });

  tool(
    'eval_in_debug_console',
    'Evaluate an expression in the debug console (REPL context) of the active session.',
    { expression: z.string(), frameId: z.number().int().optional() },
    async ({ expression, frameId }) => debugOps.evaluate(expression, frameId, 'repl')
  );

  return server;
}

export interface RunningServer {
  url: string;
  port: number;
  host: string;
  stop(): Promise<void>;
}

export async function startMcpServer(capture: CaptureManager): Promise<RunningServer> {
  const cfg = vscode.workspace.getConfiguration('vscodeDebugMcp');
  const port = cfg.get<number>('port', 6736);
  const host = cfg.get<string>('host', '127.0.0.1');

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = req.header('mcp-session-id');
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            if (transport) transports.set(id, transport);
          }
        });
        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };
        const mcp = buildMcpServer(capture);
        await mcp.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: no valid session ID' },
          id: null
        });
        return;
      }

      await transport!.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          id: null
        });
      }
    }
  });

  const sessionRouter = async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }
    await transport.handleRequest(req, res);
  };

  app.get('/mcp', sessionRouter);
  app.delete('/mcp', sessionRouter);

  app.get('/', (_req: Request, res: Response) => {
    res.json({ name: 'vscode-debug-mcp', endpoint: '/mcp', transport: 'streamable-http' });
  });

  const httpServer = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.off('error', onError);
      resolve();
    });
  });

  const url = `http://${host}:${port}/mcp`;

  return {
    url,
    port,
    host,
    async stop() {
      for (const t of transports.values()) {
        try {
          await t.close();
        } catch {
          /* ignore */
        }
      }
      transports.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  };
}
