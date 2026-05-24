import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
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
// Discovery is via a lockfile on disk that records the leader's PID and
// IPC socket path. New windows read it; if the leader is alive, they
// follow; otherwise they take over.

export interface WorkspaceInfo {
  id: string;          // sha256(path).slice(0,12)
  name: string;        // basename of path
  path: string;        // absolute workspace folder path
}

export interface ClusterMessage {
  id: string;          // request id (UUID)
  type: 'request' | 'response' | 'register' | 'registered' | 'unregister' | 'ping' | 'pong' | 'workspaces';
  tool?: string;
  args?: any;
  result?: any;
  error?: string;
  workspace?: WorkspaceInfo;
}

const LOCK_FILE = path.join(os.tmpdir(), 'vscode-debug-mcp.lock');
const SOCK_PREFIX = path.join(os.tmpdir(), 'vscode-debug-mcp-');

export function workspaceIdFor(absolutePath: string): string {
  return crypto.createHash('sha256').update(absolutePath).digest('hex').slice(0, 12);
}

interface LockData {
  pid: number;
  socket: string;
  startedAt: number;
}

function readLock(): LockData | undefined {
  try {
    const raw = fs.readFileSync(LOCK_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function writeLock(data: LockData): void {
  fs.writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2));
}

function removeLock(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* ignore */
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

/**
 * Try to connect to the leader's IPC socket and ping it. Returns the
 * socket on success; undefined if the leader is gone.
 */
async function probeLeader(socketPath: string, timeoutMs = 500): Promise<net.Socket | undefined> {
  return new Promise((resolve) => {
    const sock = net.createConnection(socketPath);
    const cleanup = () => {
      sock.removeAllListeners();
    };
    const t = setTimeout(() => {
      cleanup();
      sock.destroy();
      resolve(undefined);
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(t);
      cleanup();
      resolve(sock);
    });
    sock.once('error', () => {
      clearTimeout(t);
      cleanup();
      sock.destroy();
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

  constructor(ownWorkspace: WorkspaceInfo, private localDispatch: ToolDispatch) {
    super();
    this.ownWorkspace = ownWorkspace;
    this.socketPath = `${SOCK_PREFIX}${process.pid}.sock`;
    this.server = net.createServer((sock) => this.handleFollower(sock));
  }

  async start(): Promise<void> {
    // Clean any stale socket file at our chosen path.
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
    writeLock({ pid: process.pid, socket: this.socketPath, startedAt: Date.now() });
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
    // Only remove the lock if it still points at us (avoid clobbering a
    // newly-promoted leader).
    const lock = readLock();
    if (lock && lock.pid === process.pid) removeLock();
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
        // If two windows somehow share the same workspace id, the latest
        // registration wins.
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

    // Heartbeat to detect leader death
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

// ---------------- Coordinator ----------------

/**
 * Decide whether to act as leader or follower. If a live leader exists,
 * follow it. Otherwise become leader.
 */
export interface DiscoveryResult {
  role: 'leader' | 'follower';
  leaderSocketPath?: string; // only set when role === 'follower'
}

export async function discoverRole(): Promise<DiscoveryResult> {
  const lock = readLock();
  if (lock) {
    if (lock.pid !== process.pid && pidAlive(lock.pid)) {
      const probe = await probeLeader(lock.socket);
      if (probe) {
        probe.destroy();
        return { role: 'follower', leaderSocketPath: lock.socket };
      }
      // PID alive but socket dead — treat as stale, take over.
    }
    // Stale lock; clean up.
    removeLock();
  }
  return { role: 'leader' };
}
