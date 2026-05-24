import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import * as http from 'http';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

// Cross-window leader/follower coordination.
//
// One VS Code window per machine acts as the LEADER and owns the MCP HTTP
// server on the configured port. All other windows act as FOLLOWERS and
// connect to the leader over a Unix-domain socket. The leader maintains a
// registry of workspaces (one per follower + its own) and forwards tool
// calls to the right follower based on MCP session -> workspace binding.
//
// Discovery is by **port probing** — no lockfile. New windows try to bind
// the configured port; on success they become the leader, on EADDRINUSE
// they ask the existing leader (via HTTP GET /cluster) for its IPC
// socket path and connect as a follower. The leader's HTTP server is the
// single source of truth — when it dies, the port frees and the next
// candidate naturally takes over.

export interface WorkspaceInfo {
  id: string;          // sha256(path).slice(0,12)
  name: string;        // basename of path
  path: string;        // absolute workspace folder path
}

export interface ClusterInfo {
  product: 'vscode-debug-mcp';
  pid: number;
  socket: string;       // absolute IPC socket path
  startedAt: number;
}

export interface ClusterMessage {
  id: string;          // request id (UUID)
  type: 'request' | 'response' | 'register' | 'registered' | 'unregister' | 'ping' | 'pong';
  tool?: string;
  args?: any;
  result?: any;
  error?: string;
  workspace?: WorkspaceInfo;
}

const SOCK_PREFIX = path.join(os.tmpdir(), 'vscode-debug-mcp-');

export function workspaceIdFor(absolutePath: string): string {
  return crypto.createHash('sha256').update(absolutePath).digest('hex').slice(0, 12);
}

/**
 * Probe `host:port` for a Debug MCP leader. Returns the cluster info if
 * the responder is our leader, undefined otherwise (no listener, or some
 * other app on the port).
 */
export function probeLeaderHttp(host: string, port: number, timeoutMs = 1500): Promise<ClusterInfo | undefined> {
  return new Promise((resolve) => {
    const req = http.get(
      { host, port, path: '/cluster', timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(undefined);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body) as ClusterInfo;
            if (parsed?.product === 'vscode-debug-mcp' && typeof parsed.socket === 'string') {
              resolve(parsed);
            } else {
              resolve(undefined);
            }
          } catch {
            resolve(undefined);
          }
        });
      }
    );
    req.on('error', () => resolve(undefined));
    req.on('timeout', () => {
      req.destroy();
      resolve(undefined);
    });
  });
}

// Frame a JSON message as a single line. Both sides newline-delimited.
function send(sock: net.Socket, msg: ClusterMessage): void {
  sock.write(JSON.stringify(msg) + '\n');
}

function setupLineReader(sock: net.Socket, onMessage: (msg: ClusterMessage) => void): void {
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as ClusterMessage;
        onMessage(msg);
      } catch {
        /* ignore malformed */
      }
    }
  });
}

// ---------------- Leader ----------------

export interface ToolDispatch {
  (tool: string, args: any): Promise<any>;
}

export class Leader extends EventEmitter {
  private server: net.Server;
  private followers = new Map<string, { sock: net.Socket; workspace: WorkspaceInfo }>();
  private pendingByFollower = new Map<string, Map<string, (msg: ClusterMessage) => void>>();
  private ownWorkspace: WorkspaceInfo;
  private socketPath: string;
  private startedAt = Date.now();

  constructor(ownWorkspace: WorkspaceInfo, private localDispatch: ToolDispatch) {
    super();
    this.ownWorkspace = ownWorkspace;
    this.socketPath = `${SOCK_PREFIX}${process.pid}.sock`;
    this.server = net.createServer((sock) => this.handleFollower(sock));
  }

  async start(): Promise<void> {
    try {
      await fsp.unlink(this.socketPath);
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    this.startedAt = Date.now();
  }

  getClusterInfo(): ClusterInfo {
    return {
      product: 'vscode-debug-mcp',
      pid: process.pid,
      socket: this.socketPath,
      startedAt: this.startedAt
    };
  }

  async stop(): Promise<void> {
    for (const f of this.followers.values()) {
      try {
        f.sock.destroy();
      } catch {
        /* ignore */
      }
    }
    this.followers.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    try {
      await fsp.unlink(this.socketPath);
    } catch {
      /* ignore */
    }
  }

  listWorkspaces(): WorkspaceInfo[] {
    return [
      { ...this.ownWorkspace },
      ...Array.from(this.followers.values()).map((f) => ({ ...f.workspace }))
    ];
  }

  getOwnWorkspace(): WorkspaceInfo {
    return this.ownWorkspace;
  }

  hasWorkspace(id: string): boolean {
    return id === this.ownWorkspace.id || this.followers.has(id);
  }

  /**
   * Dispatch a tool call to the workspace with the given id. If id is
   * undefined or matches the leader's own workspace, executes locally.
   */
  async dispatch(workspaceId: string | undefined, tool: string, args: any): Promise<any> {
    const targetId = workspaceId ?? this.ownWorkspace.id;
    if (targetId === this.ownWorkspace.id) {
      return this.localDispatch(tool, args);
    }
    const follower = this.followers.get(targetId);
    if (!follower) throw new Error(`Unknown workspace id: ${targetId}`);
    return this.forwardToFollower(follower.sock, tool, args);
  }

  private forwardToFollower(sock: net.Socket, tool: string, args: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const pending = this.pendingByFollower.get(this.socketKey(sock));
      if (!pending) return reject(new Error('Follower no longer registered'));
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Tool ${tool} timed out on follower`));
      }, 60_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      });
      send(sock, { id, type: 'request', tool, args });
    });
  }

  private socketKey(sock: net.Socket): string {
    return `${(sock as any)._handle?.fd ?? sock.remoteAddress ?? Math.random()}`;
  }

  private handleFollower(sock: net.Socket): void {
    const key = this.socketKey(sock);
    this.pendingByFollower.set(key, new Map());
    let registered: WorkspaceInfo | undefined;

    setupLineReader(sock, (msg) => {
      if (msg.type === 'register' && msg.workspace) {
        registered = msg.workspace;
        this.followers.set(registered.id, { sock, workspace: registered });
        send(sock, { id: msg.id, type: 'registered' });
        this.emit('workspaces-changed');
      } else if (msg.type === 'response') {
        const pending = this.pendingByFollower.get(key);
        const cb = pending?.get(msg.id);
        if (cb) {
          pending!.delete(msg.id);
          cb(msg);
        }
      } else if (msg.type === 'ping') {
        send(sock, { id: msg.id, type: 'pong' });
      }
    });

    sock.on('close', () => {
      if (registered) {
        this.followers.delete(registered.id);
        this.emit('workspaces-changed');
      }
      this.pendingByFollower.delete(key);
    });
    sock.on('error', () => { /* close handler will clean up */ });
  }
}

// ---------------- Follower ----------------

export class Follower extends EventEmitter {
  private sock?: net.Socket;
  private pending = new Map<string, (msg: ClusterMessage) => void>();
  private heartbeat?: NodeJS.Timeout;
  private closed = false;

  constructor(
    private ownWorkspace: WorkspaceInfo,
    private leaderSocketPath: string,
    private localDispatch: ToolDispatch
  ) {
    super();
  }

  async connect(): Promise<void> {
    this.sock = net.createConnection(this.leaderSocketPath);
    await new Promise<void>((resolve, reject) => {
      this.sock!.once('connect', () => resolve());
      this.sock!.once('error', reject);
    });
    this.sock!.removeAllListeners('error');
    setupLineReader(this.sock!, (msg) => this.handleMessage(msg));
    this.sock!.on('close', () => {
      if (!this.closed) this.emit('disconnected');
    });
    this.sock!.on('error', () => { /* close fires next */ });

    // Send registration
    const regId = crypto.randomUUID();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Registration timed out')), 5_000);
      this.pending.set(regId, (msg) => {
        clearTimeout(t);
        if (msg.type === 'registered') resolve();
        else reject(new Error(msg.error ?? 'registration failed'));
      });
      send(this.sock!, { id: regId, type: 'register', workspace: this.ownWorkspace });
    });

    this.heartbeat = setInterval(() => this.ping(), 10_000);
  }

  private ping(): void {
    if (!this.sock || this.sock.destroyed) return;
    send(this.sock, { id: crypto.randomUUID(), type: 'ping' });
  }

  private async handleMessage(msg: ClusterMessage): Promise<void> {
    if (msg.type === 'request' && msg.tool) {
      try {
        const result = await this.localDispatch(msg.tool, msg.args);
        send(this.sock!, { id: msg.id, type: 'response', result });
      } catch (err) {
        send(this.sock!, {
          id: msg.id,
          type: 'response',
          error: err instanceof Error ? err.message : String(err)
        });
      }
    } else if (msg.type === 'pong' || msg.type === 'registered') {
      const cb = this.pending.get(msg.id);
      if (cb) {
        this.pending.delete(msg.id);
        cb(msg);
      }
    }
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.sock) {
      this.sock.destroy();
      this.sock = undefined;
    }
  }
}
