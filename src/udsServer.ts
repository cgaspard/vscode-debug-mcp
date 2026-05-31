import * as net from 'net';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessage, JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

import { buildMcpServer, type MCPServerEnv } from './mcpServer';

/** Stable per-workspace id: sha256(absolutePath) truncated. Mirrored by the bridge. */
export function workspaceIdFor(absolutePath: string): string {
  return crypto.createHash('sha256').update(absolutePath).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Per-window Unix-domain-socket MCP server.
//
// This listener is NOT a singleton: every VS Code window binds its OWN socket,
// named deterministically from its workspace folder. A tiny stdio bridge
// (src/bridge.ts) that `claude` spawns computes the same socket name from
// CLAUDE_PROJECT_DIR and connects. Because the process tree pins each `claude`
// to its window, there is no leader/follower routing and no workspace demux —
// every dispatch runs locally in this window.
//
// Wire protocol on the socket is newline-delimited JSON-RPC, exactly what
// MCP's stdio transport produces, so the bridge is a dumb byte relay.
// ---------------------------------------------------------------------------

export function socketDirForUser(): string {
  // Keep it short — sun_path is capped at ~104 (macOS) / 108 (Linux) bytes.
  return path.join(os.tmpdir(), 'vscode-debug-mcp');
}

/**
 * Deterministic per-workspace socket path. The bridge computes the IDENTICAL
 * path from CLAUDE_PROJECT_DIR, so a `claude` launched in this workspace finds
 * this window's socket. `disambiguator` (a pid) is appended only when the same
 * folder is already bound by another window, so the second window still gets a
 * reachable socket (advertised via the registry).
 */
export function socketPathFor(absWorkspacePath: string, disambiguator?: number): string {
  const id = workspaceIdFor(absWorkspacePath);
  const suffix = disambiguator ? `-${disambiguator}` : '';
  const name = process.platform === 'win32'
    ? `\\\\.\\pipe\\vscode-debug-mcp-${id}${suffix}`
    : path.join(socketDirForUser(), `${id}${suffix}.sock`);
  return name;
}

// A minimal MCP Transport backed by a single net.Socket. Mirrors the SDK's
// StdioServerTransport framing (newline-delimited JSON) but over a socket.
class SocketServerTransport implements Transport {
  private buf = '';
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(private sock: net.Socket) {}

  async start(): Promise<void> {
    this.sock.setEncoding('utf8');
    this.sock.on('data', (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSONRPCMessageSchema.parse(JSON.parse(line));
          this.onmessage?.(msg);
        } catch (err) {
          this.onerror?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    this.sock.on('close', () => this.onclose?.());
    this.sock.on('error', (err) => this.onerror?.(err));
  }

  async send(message: JSONRPCMessage): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.sock.write(JSON.stringify(message) + '\n', (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.sock.destroy();
  }
}

export interface RunningUdsServer {
  socketPath: string;
  stop(): Promise<void>;
}

/**
 * Start the per-window UDS MCP server. `env` is the same dispatch surface the
 * HTTP server uses; here every call resolves to the local window, so a trivial
 * single-workspace env is sufficient.
 */
export async function startUdsServer(env: MCPServerEnv, absWorkspacePath: string): Promise<RunningUdsServer> {
  let socketPath = socketPathFor(absWorkspacePath);

  // Best-effort: make sure the socket dir exists and any stale socket is gone.
  if (process.platform !== 'win32') {
    await fsp.mkdir(socketDirForUser(), { recursive: true }).catch(() => {});
  }

  const server = net.createServer((sock) => {
    // One MCP server instance per connection. sessionWorkspace/sessionId are
    // unused here (no multi-window routing) — pass inert stubs.
    const mcp = buildMcpServer(env, new Map(), () => undefined);
    const transport = new SocketServerTransport(sock);
    mcp.connect(transport).catch(() => sock.destroy());
  });

  const listen = (p: string) =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => reject(err);
      server.once('error', onError);
      server.listen(p, () => {
        server.off('error', onError);
        resolve();
      });
    });

  // Try the deterministic path. If it's already in use (same folder open in
  // another window, or a stale socket), clear a stale file and retry once,
  // then fall back to a pid-disambiguated path.
  try {
    if (process.platform !== 'win32') await fsp.unlink(socketPath).catch(() => {});
    await listen(socketPath);
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      socketPath = socketPathFor(absWorkspacePath, process.pid);
      await listen(socketPath);
    } else {
      throw err;
    }
  }

  await writeRegistry(absWorkspacePath, socketPath);

  return {
    socketPath,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (process.platform !== 'win32') await fsp.unlink(socketPath).catch(() => {});
      await removeRegistry(absWorkspacePath, socketPath).catch(() => {});
    }
  };
}

// ---- Registry: {workspacePath -> socketPath} so the bridge has a fallback ----
// when CLAUDE_PROJECT_DIR doesn't hash to the deterministic path (multi-root,
// .code-workspace, or pid-disambiguated second window).

function registryPath(): string {
  return path.join(os.homedir(), '.claude', 'vscode-debug', 'registry.json');
}

interface RegistryEntry {
  workspacePath: string;
  socketPath: string;
  pid: number;
}

async function readRegistry(): Promise<RegistryEntry[]> {
  try {
    const raw = await fsp.readFile(registryPath(), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data?.entries) ? data.entries : [];
  } catch {
    return [];
  }
}

async function writeRegistry(workspacePath: string, socketPath: string): Promise<void> {
  const file = registryPath();
  await fsp.mkdir(path.dirname(file), { recursive: true }).catch(() => {});
  const entries = (await readRegistry()).filter((e) => e.pid !== process.pid && e.socketPath !== socketPath);
  entries.push({ workspacePath, socketPath, pid: process.pid });
  await fsp.writeFile(file, JSON.stringify({ entries }, null, 2) + '\n', 'utf8').catch(() => {});
}

async function removeRegistry(_workspacePath: string, socketPath: string): Promise<void> {
  const file = registryPath();
  const entries = (await readRegistry()).filter((e) => e.socketPath !== socketPath && e.pid !== process.pid);
  await fsp.writeFile(file, JSON.stringify({ entries }, null, 2) + '\n', 'utf8').catch(() => {});
}
