import * as vscode from 'vscode';

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
  }
};
