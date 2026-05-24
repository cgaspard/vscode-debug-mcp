import * as vscode from 'vscode';
import { CaptureManager } from './capture';
import { startMcpServer, type RunningServer } from './mcpServer';
import { offerInstall, resetInstallPromptFlag } from './firstRun';

let capture: CaptureManager | undefined;
let server: RunningServer | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

function log(msg: string) {
  if (!output) output = vscode.window.createOutputChannel('Debug MCP');
  const ts = new Date().toISOString();
  output.appendLine(`[${ts}] ${msg}`);
}

function updateStatusBar() {
  if (!statusBar) return;
  if (server) {
    statusBar.text = `$(debug-alt) MCP :${server.port}`;
    statusBar.tooltip = `Debug MCP server running at ${server.url}\nClick to copy URL.`;
    statusBar.command = 'vscodeDebugMcp.copyUrl';
  } else {
    statusBar.text = '$(debug-alt) MCP off';
    statusBar.tooltip = 'Debug MCP server is stopped. Click to start.';
    statusBar.command = 'vscodeDebugMcp.start';
  }
  statusBar.show();
}

async function startServer() {
  if (server) {
    vscode.window.showInformationMessage(`Debug MCP already running at ${server.url}`);
    return;
  }
  if (!capture) {
    capture = new CaptureManager(() =>
      vscode.workspace.getConfiguration('vscodeDebugMcp').get<number>('terminalBufferLines', 2000)
    );
  }
  try {
    server = await startMcpServer(capture);
    log(`MCP server listening at ${server.url}`);
    vscode.window.showInformationMessage(`Debug MCP running at ${server.url}`);
    if (extensionContext) {
      void offerInstall(extensionContext, server.url);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to start MCP server: ${msg}`);
    vscode.window.showErrorMessage(`Failed to start Debug MCP: ${msg}`);
  }
  updateStatusBar();
}

async function stopServer() {
  if (!server) return;
  try {
    await server.stop();
    log('MCP server stopped.');
  } catch (err) {
    log(`Error stopping server: ${err instanceof Error ? err.message : err}`);
  }
  server = undefined;
  updateStatusBar();
}

export async function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  output = vscode.window.createOutputChannel('Debug MCP');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(output, statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand('vscodeDebugMcp.start', startServer),
    vscode.commands.registerCommand('vscodeDebugMcp.stop', stopServer),
    vscode.commands.registerCommand('vscodeDebugMcp.showInfo', () => {
      if (!server) {
        vscode.window.showInformationMessage('Debug MCP server is not running.');
        return;
      }
      vscode.window.showInformationMessage(`Debug MCP running at ${server.url}`);
    }),
    vscode.commands.registerCommand('vscodeDebugMcp.copyUrl', async () => {
      if (!server) {
        await vscode.commands.executeCommand('vscodeDebugMcp.start');
        return;
      }
      await vscode.env.clipboard.writeText(server.url);
      vscode.window.showInformationMessage(`Copied ${server.url} to clipboard`);
    }),
    vscode.commands.registerCommand('vscodeDebugMcp.configureClaudeCode', async () => {
      if (!server) {
        const choice = await vscode.window.showWarningMessage(
          'The MCP server is not running. Start it first to configure Claude Code.',
          'Start server'
        );
        if (choice === 'Start server') await startServer();
        if (!server) return;
      }
      await offerInstall(context, server!.url, { force: true });
    }),
    vscode.commands.registerCommand('vscodeDebugMcp.resetInstallPrompt', async () => {
      await resetInstallPromptFlag(context);
      vscode.window.showInformationMessage('Debug MCP: install prompt will show again next activation.');
    })
  );

  context.subscriptions.push({
    dispose: () => {
      void stopServer();
      capture?.dispose();
      capture = undefined;
    }
  });

  updateStatusBar();

  const autoStart = vscode.workspace.getConfiguration('vscodeDebugMcp').get<boolean>('autoStart', true);
  if (autoStart) {
    await startServer();
  }
}

export function deactivate() {
  return stopServer();
}
