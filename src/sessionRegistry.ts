import * as vscode from 'vscode';

// Tracks the lifecycle of debug sessions — start, stop, pause, continue,
// terminate — so MCP tools can answer "what's currently happening?" and
// "what just happened?" without polling the active session.
//
// Captures the LATEST stopped event per session (file, line, thread,
// reason, stack-trace snapshot). After the user continues execution,
// the captured snapshot remains queryable via get_last_stopped_event.

export type SessionStatus = 'starting' | 'running' | 'paused' | 'terminated';

export interface StoppedEventSnapshot {
  threadId?: number;
  reason?: string;          // 'breakpoint' | 'exception' | 'step' | 'pause' | 'entry' | string
  description?: string;
  text?: string;
  hitBreakpointIds?: number[];
  allThreadsStopped?: boolean;
  capturedAt: number;       // epoch ms
  // Optional resolved metadata — populated by enrichLastStopped() if the
  // session is still paused when we have a chance to ask the DAP.
  frame?: {
    name?: string;
    file?: string;
    line?: number;
    column?: number;
  };
  stackTrace?: Array<{
    id: number;
    name: string;
    file?: string;
    line?: number;
    column?: number;
  }>;
}

export interface SessionRecord {
  id: string;               // vscode session id
  name: string;
  type: string;
  workspaceFolder?: string;
  startedAt: number;
  status: SessionStatus;
  parentSessionId?: string;
  lastStopped?: StoppedEventSnapshot;
}

export class SessionRegistry implements vscode.Disposable {
  private sessions = new Map<string, SessionRecord>();
  private disposables: vscode.Disposable[] = [];

  constructor() {
    this.disposables.push(
      vscode.debug.onDidStartDebugSession((s) => this.onStart(s)),
      vscode.debug.onDidTerminateDebugSession((s) => this.onTerminate(s)),
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: (session) => ({
          onDidSendMessage: (msg: any) => this.onDapMessage(session, msg)
        })
      })
    );

    // Seed with any already-active session (e.g. extension activated
    // after the user already started debugging).
    for (const s of vscode.debug.activeDebugSession ? [vscode.debug.activeDebugSession] : []) {
      this.onStart(s);
    }
  }

  list(): SessionRecord[] {
    return Array.from(this.sessions.values()).map((r) => ({ ...r }));
  }

  get(id: string): SessionRecord | undefined {
    const r = this.sessions.get(id);
    return r ? { ...r } : undefined;
  }

  /** Active session as VS Code sees it, or undefined. */
  active(): SessionRecord | undefined {
    const a = vscode.debug.activeDebugSession;
    if (!a) return undefined;
    return this.get(a.id);
  }

  /**
   * Best-effort: enrich the most recent stopped event with stack trace
   * details. Called from get_last_stopped_event handlers to provide
   * "where am I" data even after the user has continued execution
   * (snapshot is captured at stop time).
   */
  async enrichLastStopped(sessionId: string, levels = 5): Promise<SessionRecord | undefined> {
    const rec = this.sessions.get(sessionId);
    if (!rec?.lastStopped) return rec ? { ...rec } : undefined;

    // If we already have a stack trace captured, return as-is.
    if (rec.lastStopped.stackTrace?.length) return { ...rec };

    const vsSession = vscode.debug.activeDebugSession?.id === sessionId
      ? vscode.debug.activeDebugSession
      : undefined;
    if (!vsSession || rec.status !== 'paused' || rec.lastStopped.threadId === undefined) {
      // Can't fetch live data; return what we have.
      return { ...rec };
    }

    try {
      const res = await vsSession.customRequest('stackTrace', {
        threadId: rec.lastStopped.threadId,
        startFrame: 0,
        levels
      });
      const frames = (res?.stackFrames ?? []) as any[];
      rec.lastStopped.stackTrace = frames.map((f) => ({
        id: f.id,
        name: f.name,
        file: f.source?.path,
        line: f.line,
        column: f.column
      }));
      if (frames[0]) {
        rec.lastStopped.frame = {
          name: frames[0].name,
          file: frames[0].source?.path,
          line: frames[0].line,
          column: frames[0].column
        };
      }
    } catch {
      /* best effort */
    }
    return { ...rec };
  }

  private onStart(s: vscode.DebugSession): void {
    if (this.sessions.has(s.id)) return;
    this.sessions.set(s.id, {
      id: s.id,
      name: s.name,
      type: s.type,
      workspaceFolder: s.workspaceFolder?.name,
      startedAt: Date.now(),
      status: 'starting',
      parentSessionId: s.parentSession?.id
    });
  }

  private onTerminate(s: vscode.DebugSession): void {
    const rec = this.sessions.get(s.id);
    if (!rec) return;
    rec.status = 'terminated';
    // Keep terminated sessions in the map briefly so list_debug_sessions
    // shows them as recent history. Garbage-collect after 5 minutes.
    setTimeout(() => {
      const cur = this.sessions.get(s.id);
      if (cur && cur.status === 'terminated') this.sessions.delete(s.id);
    }, 5 * 60 * 1000);
  }

  private onDapMessage(s: vscode.DebugSession, msg: any): void {
    if (!msg || msg.type !== 'event') return;
    const rec = this.sessions.get(s.id);
    if (!rec) return;
    switch (msg.event) {
      case 'initialized':
        rec.status = 'running';
        break;
      case 'stopped': {
        rec.status = 'paused';
        const body = msg.body ?? {};
        rec.lastStopped = {
          threadId: typeof body.threadId === 'number' ? body.threadId : undefined,
          reason: body.reason,
          description: body.description,
          text: body.text,
          hitBreakpointIds: body.hitBreakpointIds,
          allThreadsStopped: body.allThreadsStopped,
          capturedAt: Date.now()
        };
        // Fire-and-forget stack-trace enrichment so even if the user
        // continues quickly, we have frame data cached.
        void this.captureStackTraceSnapshot(s, rec.lastStopped);
        break;
      }
      case 'continued':
        rec.status = 'running';
        break;
      case 'terminated':
      case 'exited':
        rec.status = 'terminated';
        break;
    }
  }

  private async captureStackTraceSnapshot(s: vscode.DebugSession, stopped: StoppedEventSnapshot): Promise<void> {
    if (stopped.threadId === undefined) return;
    try {
      const res = await s.customRequest('stackTrace', {
        threadId: stopped.threadId,
        startFrame: 0,
        levels: 10
      });
      const frames = (res?.stackFrames ?? []) as any[];
      stopped.stackTrace = frames.map((f) => ({
        id: f.id,
        name: f.name,
        file: f.source?.path,
        line: f.line,
        column: f.column
      }));
      if (frames[0]) {
        stopped.frame = {
          name: frames[0].name,
          file: frames[0].source?.path,
          line: frames[0].line,
          column: frames[0].column
        };
      }
    } catch {
      /* ignore — snapshot stays minimal */
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables = [];
    this.sessions.clear();
  }
}
