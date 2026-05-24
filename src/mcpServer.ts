import * as vscode from 'vscode';
import express, { type Request, type Response } from 'express';
import * as http from 'http';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { WorkspaceInfo, ClusterInfo } from './cluster';

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

/**
 * The shape the MCP server expects from its hosting environment. The
 * hosting code is responsible for routing dispatch() to either the local
 * window or another window's follower over the cluster IPC.
 */
export interface MCPServerEnv {
  /** Run a tool against a specific workspace. */
  dispatch(workspaceId: string | undefined, tool: string, args: any): Promise<unknown>;
  /** List all known workspaces in the cluster. */
  listWorkspaces(): WorkspaceInfo[];
  /** The workspace ID to use when no binding has been made yet. */
  defaultWorkspaceId(): string;
  /** Info served at GET /cluster so other windows can discover us. */
  getClusterInfo(): ClusterInfo;
}

function buildMcpServer(env: MCPServerEnv, sessionWorkspace: Map<string, string>, sessionId: () => string | undefined): McpServer {
  const server = new McpServer(
    { name: 'vscode-debug-mcp', version: '0.1.0' },
    { capabilities: { tools: {}, logging: {} } }
  );

  const currentWorkspace = (): string | undefined => {
    const sid = sessionId();
    if (sid && sessionWorkspace.has(sid)) return sessionWorkspace.get(sid);
    return env.defaultWorkspaceId();
  };

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

  // Forwarded tool: routes to the workspace bound to this MCP session.
  const forwarded = (
    name: string,
    description: string,
    schema: z.ZodRawShape
  ) => {
    tool(name, description, schema, async (args: any) => {
      return env.dispatch(currentWorkspace(), name, args);
    });
  };

  // ---------- Multi-window workspace tools ----------
  tool(
    'list_workspaces',
    'List all VS Code workspaces currently registered with this Debug MCP cluster (across all open windows). Each workspace has a stable id (sha256 hash slice of its path), a name (folder basename), and an absolute path. Use this when the user has multiple VS Code windows open to discover which one you should target.',
    {},
    () => env.listWorkspaces()
  );

  tool(
    'bind_workspace',
    'Bind this MCP chat session to a specific VS Code workspace by id (from list_workspaces). All subsequent tool calls in this session will be routed to that workspace. If you never call this, calls go to the leader window\'s workspace by default. Call this once at the start of a multi-window session, or any time the user asks you to switch windows.',
    { workspaceId: z.string() },
    ({ workspaceId }: { workspaceId: string }) => {
      const workspaces = env.listWorkspaces();
      if (!workspaces.some((w) => w.id === workspaceId)) {
        throw new Error(`Unknown workspace id: ${workspaceId}. Run list_workspaces to see available ids.`);
      }
      const sid = sessionId();
      if (!sid) throw new Error('No MCP session id available; cannot bind.');
      sessionWorkspace.set(sid, workspaceId);
      const match = workspaces.find((w) => w.id === workspaceId)!;
      return { bound: true, workspace: match };
    }
  );

  // ---------- Forwarded tools ----------
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

export interface RunningServer {
  url: string;
  port: number;
  host: string;
  stop(): Promise<void>;
}

export async function startMcpServer(env: MCPServerEnv): Promise<RunningServer> {
  const cfg = vscode.workspace.getConfiguration('vscodeDebugMcp');
  const port = cfg.get<number>('port', 6736);
  const host = cfg.get<string>('host', '127.0.0.1');

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const transports = new Map<string, StreamableHTTPServerTransport>();
  // Session-id (string) -> bound workspace id (string).
  const sessionWorkspace = new Map<string, string>();

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = req.header('mcp-session-id');
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const newTransport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, newTransport);
          }
        });
        newTransport.onclose = () => {
          if (newTransport.sessionId) {
            transports.delete(newTransport.sessionId);
            sessionWorkspace.delete(newTransport.sessionId);
          }
        };
        const mcp = buildMcpServer(env, sessionWorkspace, () => newTransport.sessionId);
        await mcp.connect(newTransport);
        transport = newTransport;
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

  app.get('/cluster', (_req: Request, res: Response) => {
    res.json(env.getClusterInfo());
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
      sessionWorkspace.clear();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  };
}
