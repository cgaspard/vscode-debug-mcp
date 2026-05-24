import * as vscode from 'vscode';

interface BufferEntry {
  name: string;
  lines: string[];
  source: 'terminal' | 'debugConsole';
}

const MAX_LINE_LEN = 4000;

// Strip ANSI escape sequences (CSI, OSC including VS Code shell-integration
// OSC 633, and standalone ESC-introducer sequences) so the captured buffer is
// plain text.
const ANSI_PATTERN = new RegExp(
  [
    '\\x1B\\][^\\x07\\x1B]*(?:\\x07|\\x1B\\\\)', // OSC ... BEL or ST
    '\\x1B\\[[0-?]*[ -/]*[@-~]', // CSI
    '\\x1B[@-Z\\\\-_]' // 2-byte ESC seq
  ].join('|'),
  'g'
);

function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, '');
}

export class CaptureManager implements vscode.Disposable {
  private terminalBuffers = new Map<string, BufferEntry>();
  private debugConsoleBuffer: BufferEntry = {
    name: 'Debug Console',
    lines: [],
    source: 'debugConsole'
  };
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly maxLines: () => number) {
    this.disposables.push(
      vscode.window.onDidChangeTerminalShellIntegration((e) => {
        this.ensureBuffer(e.terminal);
      })
    );

    this.disposables.push(
      vscode.window.onDidCloseTerminal((t) => {
        const key = this.terminalKey(t);
        this.terminalBuffers.delete(key);
      })
    );

    // Subscribe ONCE globally — must read the stream at start time so we
    // don't miss the body emitted between OSC 633 ; C and ; D.
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution(async (e) => {
        const entry = this.ensureBuffer(e.terminal);
        const commandLine = e.execution.commandLine.value;
        const stream = e.execution.read();
        let body = '';
        try {
          for await (const data of stream) {
            body += data;
          }
        } catch {
          // ignore read errors
        }
        const cleaned = stripAnsi(body).replace(/\r/g, '');
        const header = `\n$ ${commandLine}`;
        this.appendToBuffer(entry, header + (cleaned.startsWith('\n') ? cleaned : '\n' + cleaned));
      })
    );

    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution((e) => {
        const entry = this.ensureBuffer(e.terminal);
        this.appendToBuffer(entry, `[exit ${e.exitCode ?? '?'}]\n`);
      })
    );

    // Seed buffers for any already-open terminals so they appear in list_terminals.
    for (const t of vscode.window.terminals) {
      this.ensureBuffer(t);
    }

    // Capture debug console output via DebugAdapterTracker.
    this.disposables.push(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: (session) => {
          return {
            onDidSendMessage: (msg: any) => {
              if (msg?.type === 'event' && msg.event === 'output') {
                const body = msg.body ?? {};
                const category = body.category ?? 'console';
                const text = String(body.output ?? '');
                if (!text) return;
                const prefix = `[${session.name}/${category}] `;
                this.pushDebugLines(prefix, text);
              }
            }
          };
        }
      })
    );
  }

  private terminalKey(t: vscode.Terminal): string {
    return `${(t as any)._id ?? t.processId ?? t.name}`;
  }

  private ensureBuffer(terminal: vscode.Terminal): BufferEntry {
    const key = this.terminalKey(terminal);
    let entry = this.terminalBuffers.get(key);
    if (!entry) {
      entry = { name: terminal.name, lines: [], source: 'terminal' };
      this.terminalBuffers.set(key, entry);
    } else if (entry.name !== terminal.name) {
      entry.name = terminal.name;
    }
    return entry;
  }

  private appendToBuffer(entry: BufferEntry, text: string) {
    const cap = this.maxLines();
    const lines = text.split(/\r?\n/).map((l) => (l.length > MAX_LINE_LEN ? l.slice(0, MAX_LINE_LEN) + '…' : l));
    entry.lines.push(...lines);
    if (entry.lines.length > cap) {
      entry.lines.splice(0, entry.lines.length - cap);
    }
  }

  private pushDebugLines(prefix: string, text: string) {
    const cap = this.maxLines();
    const cleaned = stripAnsi(text);
    const lines = cleaned.split(/\r?\n/).filter((l) => l.length > 0).map((l) => prefix + l);
    this.debugConsoleBuffer.lines.push(...lines);
    if (this.debugConsoleBuffer.lines.length > cap) {
      this.debugConsoleBuffer.lines.splice(0, this.debugConsoleBuffer.lines.length - cap);
    }
  }

  listTerminals(): { id: string; name: string; lineCount: number }[] {
    return Array.from(this.terminalBuffers.entries()).map(([id, b]) => ({
      id,
      name: b.name,
      lineCount: b.lines.length
    }));
  }

  readTerminal(idOrName: string, tail?: number): { name: string; lines: string[] } | undefined {
    let entry = this.terminalBuffers.get(idOrName);
    if (!entry) {
      for (const b of this.terminalBuffers.values()) {
        if (b.name === idOrName) {
          entry = b;
          break;
        }
      }
    }
    if (!entry) return undefined;
    const lines = tail ? entry.lines.slice(-tail) : entry.lines.slice();
    return { name: entry.name, lines };
  }

  readDebugConsole(tail?: number): string[] {
    return tail ? this.debugConsoleBuffer.lines.slice(-tail) : this.debugConsoleBuffer.lines.slice();
  }

  clearDebugConsole() {
    this.debugConsoleBuffer.lines = [];
  }

  clearTerminal(idOrName: string): boolean {
    const result = this.readTerminal(idOrName);
    if (!result) return false;
    for (const [id, b] of this.terminalBuffers) {
      if (id === idOrName || b.name === idOrName) {
        b.lines = [];
        return true;
      }
    }
    return false;
  }

  dispose() {
    for (const d of this.disposables) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.disposables = [];
  }
}
