import * as vscode from 'vscode';
import type { SessionRegistry, SessionRecord } from './sessionRegistry';

// The session registry is injected at startup by extension.ts and reused
// here so we don't have to thread it through every method signature.
let registry: SessionRegistry | undefined;
export function setSessionRegistry(r: SessionRegistry): void {
  registry = r;
}
function requireRegistry(): SessionRegistry {
  if (!registry) throw new Error('SessionRegistry not initialized.');
  return registry;
}

export interface BreakpointInfo {
  id: string;
  enabled: boolean;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
  file?: string;
  line?: number;
  column?: number;
  functionName?: string;
}

function bpInfo(bp: vscode.Breakpoint): BreakpointInfo {
  const info: BreakpointInfo = {
    id: bp.id,
    enabled: bp.enabled,
    condition: bp.condition,
    hitCondition: bp.hitCondition,
    logMessage: bp.logMessage
  };
  if (bp instanceof vscode.SourceBreakpoint) {
    info.file = bp.location.uri.fsPath;
    info.line = bp.location.range.start.line + 1;
    info.column = bp.location.range.start.character + 1;
  } else if (bp instanceof vscode.FunctionBreakpoint) {
    info.functionName = bp.functionName;
  }
  return info;
}

function activeSession(): vscode.DebugSession {
  const s = vscode.debug.activeDebugSession;
  if (!s) throw new Error('No active debug session.');
  return s;
}

/**
 * Pick the debug session to act on. If `sessionId` is provided, look it
 * up explicitly. Otherwise fall back to vscode.debug.activeDebugSession.
 * This lets MCP tools target a specific user-started session by id
 * (from list_debug_sessions) instead of relying on which session VS
 * Code currently considers "active".
 */
function pickSession(sessionId?: string): vscode.DebugSession {
  if (sessionId) {
    // VS Code doesn't expose getDebugSessionById; iterate the known
    // sessions via the active one's siblings is not possible either.
    // The DebugSession API surface is limited — fall back to active if
    // the id happens to match it, otherwise throw with a hint.
    const active = vscode.debug.activeDebugSession;
    if (active && active.id === sessionId) return active;
    throw new Error(
      `Cannot directly access session "${sessionId}". The VS Code API only exposes the active session for direct customRequest calls. Make that session active in the debug view first, or omit sessionId to use the current active session.`
    );
  }
  return activeSession();
}

async function pickThreadId(session: vscode.DebugSession, threadId?: number): Promise<number> {
  if (typeof threadId === 'number') return threadId;
  const res = await session.customRequest('threads');
  const threads = res?.threads ?? [];
  if (!threads.length) throw new Error('No threads available in active debug session.');
  return threads[0].id;
}

export const debugOps = {
  listConfigurations(): { name: string; type: string; request: string; workspace: string }[] {
    const out: { name: string; type: string; request: string; workspace: string }[] = [];
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const cfg = vscode.workspace.getConfiguration('launch', folder.uri);
      const configurations = cfg.get<any[]>('configurations') ?? [];
      for (const c of configurations) {
        out.push({
          name: c.name,
          type: c.type,
          request: c.request,
          workspace: folder.name
        });
      }
    }
    return out;
  },

  async start(name?: string, workspaceFolder?: string): Promise<{ started: boolean; sessionName?: string }> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let folder = folders[0];
    if (workspaceFolder) {
      const match = folders.find((f) => f.name === workspaceFolder);
      if (!match) throw new Error(`Workspace folder not found: ${workspaceFolder}`);
      folder = match;
    }
    if (!folder) throw new Error('No workspace folder is open.');
    const started = await vscode.debug.startDebugging(folder, name ?? (undefined as any));
    return { started, sessionName: vscode.debug.activeDebugSession?.name };
  },

  async stop(): Promise<{ stopped: boolean }> {
    const s = vscode.debug.activeDebugSession;
    if (!s) return { stopped: false };
    await vscode.debug.stopDebugging(s);
    return { stopped: true };
  },

  async continue(threadId?: number): Promise<void> {
    const s = activeSession();
    const tid = await pickThreadId(s, threadId);
    await s.customRequest('continue', { threadId: tid });
  },

  async pause(threadId?: number): Promise<void> {
    const s = activeSession();
    const tid = await pickThreadId(s, threadId);
    await s.customRequest('pause', { threadId: tid });
  },

  async stepOver(threadId?: number): Promise<void> {
    const s = activeSession();
    const tid = await pickThreadId(s, threadId);
    await s.customRequest('next', { threadId: tid });
  },

  async stepIn(threadId?: number): Promise<void> {
    const s = activeSession();
    const tid = await pickThreadId(s, threadId);
    await s.customRequest('stepIn', { threadId: tid });
  },

  async stepOut(threadId?: number): Promise<void> {
    const s = activeSession();
    const tid = await pickThreadId(s, threadId);
    await s.customRequest('stepOut', { threadId: tid });
  },

  async getThreads(): Promise<{ id: number; name: string }[]> {
    const s = activeSession();
    const res = await s.customRequest('threads');
    return res?.threads ?? [];
  },

  async getStackTrace(threadId?: number, levels = 20) {
    const s = activeSession();
    const tid = await pickThreadId(s, threadId);
    const res = await s.customRequest('stackTrace', { threadId: tid, startFrame: 0, levels });
    return res?.stackFrames ?? [];
  },

  async getScopes(frameId: number) {
    const s = activeSession();
    const res = await s.customRequest('scopes', { frameId });
    return res?.scopes ?? [];
  },

  async getVariables(variablesReference: number) {
    const s = activeSession();
    const res = await s.customRequest('variables', { variablesReference });
    return res?.variables ?? [];
  },

  async evaluate(expression: string, frameId?: number, context: 'watch' | 'repl' | 'hover' = 'repl') {
    const s = activeSession();
    return s.customRequest('evaluate', { expression, frameId, context });
  },

  getAllBreakpoints(): BreakpointInfo[] {
    return vscode.debug.breakpoints.map(bpInfo);
  },

  getBreakpoint(id: string): BreakpointInfo | undefined {
    const bp = vscode.debug.breakpoints.find((b) => b.id === id);
    return bp ? bpInfo(bp) : undefined;
  },

  async setBreakpoint(file: string, line: number, options?: { condition?: string; hitCondition?: string; logMessage?: string }): Promise<BreakpointInfo> {
    const uri = vscode.Uri.file(file);
    const loc = new vscode.Location(uri, new vscode.Position(Math.max(0, line - 1), 0));
    const bp = new vscode.SourceBreakpoint(loc, true, options?.condition, options?.hitCondition, options?.logMessage);
    vscode.debug.addBreakpoints([bp]);
    return bpInfo(bp);
  },

  removeBreakpoint(id: string): boolean {
    const bp = vscode.debug.breakpoints.find((b) => b.id === id);
    if (!bp) return false;
    vscode.debug.removeBreakpoints([bp]);
    return true;
  },

  clearAllBreakpoints() {
    vscode.debug.removeBreakpoints(vscode.debug.breakpoints.slice());
  },

  async toggleBreakpoint(file: string, line: number): Promise<{ enabled: boolean; created: boolean }> {
    const fsPath = vscode.Uri.file(file).fsPath;
    const existing = vscode.debug.breakpoints.find((b) => {
      if (!(b instanceof vscode.SourceBreakpoint)) return false;
      return b.location.uri.fsPath === fsPath && b.location.range.start.line === line - 1;
    });
    if (existing) {
      vscode.debug.removeBreakpoints([existing]);
      return { enabled: false, created: false };
    }
    await debugOps.setBreakpoint(file, line);
    return { enabled: true, created: true };
  },

  /**
   * List every known debug session — including ones the user started
   * themselves via F5. Each entry carries status, and (if paused or
   * recently paused) a snapshot of where execution stopped.
   */
  listSessions(): (SessionRecord & { isActive: boolean })[] {
    const reg = requireRegistry();
    const activeId = vscode.debug.activeDebugSession?.id;
    return reg.list().map((r) => ({ ...r, isActive: r.id === activeId }));
  },

  /**
   * Get a snapshot of the most recent stopped event for a session.
   * Useful when the user hit a breakpoint, you joined the chat after,
   * and you need to know "what is the program doing right now / what
   * did it just stop at". Frame and stack data is captured at stop
   * time so it survives the user continuing execution.
   */
  async getLastStoppedEvent(sessionId?: string, levels = 5): Promise<SessionRecord | undefined> {
    const reg = requireRegistry();
    let targetId = sessionId;
    if (!targetId) {
      // Prefer the active session; if there isn't one, fall back to the
      // most recently paused session in the registry.
      targetId = vscode.debug.activeDebugSession?.id;
      if (!targetId) {
        const all = reg.list();
        const paused = all.filter((s) => s.lastStopped).sort(
          (a, b) => (b.lastStopped?.capturedAt ?? 0) - (a.lastStopped?.capturedAt ?? 0)
        );
        targetId = paused[0]?.id;
      }
    }
    if (!targetId) return undefined;
    return reg.enrichLastStopped(targetId, levels);
  }
};
