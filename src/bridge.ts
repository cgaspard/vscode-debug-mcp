// Standalone stdio <-> Unix-socket bridge spawned by `claude` as a stdio MCP
// server. NO vscode import — this runs as a plain Node subprocess of the
// Claude Code CLI, outside the VS Code extension host.
//
// Job: resolve the per-window socket for THIS workspace, connect, and relay
// raw bytes both ways. The real MCP server (with all tool schemas) lives in
// the VS Code extension (src/udsServer.ts); this process never parses MCP.
//
// Socket resolution order:
//   1. $VSCODE_DEBUG_MCP_SOCK  (explicit override, e.g. for testing)
//   2. deterministic path from $CLAUDE_PROJECT_DIR  (the common case)
//   3. registry lookup ~/.claude/vscode-debug/registry.json by workspace path
//
// Resilience: if the socket isn't up yet (or the extension host reloads), keep
// retrying the connect quietly so Claude Code doesn't mark the server failed.

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

function log(msg: string): void {
  // stderr only — stdout is the MCP channel and must stay pure JSON-RPC.
  process.stderr.write(`[vscode-debug-bridge] ${msg}\n`);
}

function workspaceIdFor(absolutePath: string): string {
  return crypto.createHash('sha256').update(absolutePath).digest('hex').slice(0, 12);
}

function deterministicSocketPath(absWorkspacePath: string): string {
  const id = workspaceIdFor(absWorkspacePath);
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\vscode-debug-mcp-${id}`
    : path.join(os.tmpdir(), 'vscode-debug-mcp', `${id}.sock`);
}

function registryLookup(absWorkspacePath: string): string | undefined {
  try {
    const file = path.join(os.homedir(), '.claude', 'vscode-debug', 'registry.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entries: Array<{ workspacePath: string; socketPath: string }> = data?.entries ?? [];
    // Prefer an exact match; fall back to a prefix match (multi-root: project
    // dir is a subfolder of the opened workspace, or vice versa).
    const exact = entries.find((e) => e.workspacePath === absWorkspacePath);
    if (exact) return exact.socketPath;
    const prefix = entries.find(
      (e) => absWorkspacePath.startsWith(e.workspacePath) || e.workspacePath.startsWith(absWorkspacePath)
    );
    return prefix?.socketPath;
  } catch {
    return undefined;
  }
}

function resolveSocketPath(): string | undefined {
  if (process.env.VSCODE_DEBUG_MCP_SOCK) return process.env.VSCODE_DEBUG_MCP_SOCK;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  // Try the registry first (handles multi-root + pid-disambiguated sockets);
  // fall back to the deterministic path.
  return registryLookup(projectDir) ?? deterministicSocketPath(projectDir);
}

function connectWithRetry(onConnect: (sock: net.Socket) => void): void {
  let attempt = 0;
  const tryConnect = () => {
    const target = resolveSocketPath();
    if (!target) {
      log('could not resolve a socket path; retrying…');
      setTimeout(tryConnect, 1000);
      return;
    }
    const sock = net.createConnection(target);
    sock.once('connect', () => {
      attempt = 0;
      log(`connected to ${target}`);
      onConnect(sock);
    });
    sock.once('error', (err: NodeJS.ErrnoException) => {
      attempt++;
      const delay = Math.min(2000, 200 * attempt);
      if (attempt <= 1 || attempt % 10 === 0) {
        log(`connect to ${target} failed (${err.code ?? err.message}); retrying in ${delay}ms`);
      }
      setTimeout(tryConnect, delay);
    });
  };
  tryConnect();
}

function main(): void {
  // Buffer anything Claude sends before the socket is up, then flush on connect.
  let socket: net.Socket | undefined;
  const pending: Buffer[] = [];

  process.stdin.on('data', (chunk: Buffer) => {
    if (socket && !socket.destroyed) socket.write(chunk);
    else pending.push(chunk);
  });
  process.stdin.on('end', () => socket?.end());

  const attach = (sock: net.Socket) => {
    socket = sock;
    for (const chunk of pending.splice(0)) sock.write(chunk);
    sock.on('data', (chunk: Buffer) => process.stdout.write(chunk));
    sock.on('close', () => {
      log('socket closed; the VS Code window may have reloaded. Reconnecting…');
      socket = undefined;
      // Reconnect transparently; Claude's session stays alive.
      connectWithRetry(attach);
    });
    sock.on('error', () => { /* close handler reconnects */ });
  };

  connectWithRetry(attach);
}

main();
