import * as vscode from 'vscode';
import { CaptureManager } from './capture';
import { startMcpServer, type RunningServer } from './mcpServer';
import { offerInstall, resetInstallPromptFlag, getConfigState, claudeCodeInstalled } from './firstRun';
import { registerLmTools } from './lmTools';
import { checkForUpdate } from './updater';

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
    statusBar.tooltip = `Debug MCP server running at ${server.url}\nClick for actions (install, copy URL, stop…).`;
  } else {
    statusBar.text = '$(debug-alt) MCP off';
    statusBar.tooltip = 'Debug MCP server is stopped. Click for actions.';
  }
  statusBar.command = 'vscodeDebugMcp.showMenu';
  statusBar.show();
}

async function showStatusBarMenu() {
  const state = await getConfigState();
  const hasClaude = claudeCodeInstalled();

  type Item = vscode.QuickPickItem & { id: string };
  const items: Item[] = [];

  if (server) {
    items.push({
      id: 'copyUrl',
      label: '$(clippy) Copy server URL',
      description: server.url
    });
  } else {
    items.push({
      id: 'start',
      label: '$(play) Start MCP server',
      description: 'Bind the local HTTP server'
    });
  }

  if (hasClaude) {
    if (!state.userConfigured && !state.workspaceConfigured) {
      items.push({
        id: 'install',
        label: '$(rocket) Install Claude Code support…',
        description: 'Not yet configured — register the MCP server and (optionally) the usage skill'
      });
    } else {
      const tags: string[] = [];
      if (state.workspaceConfigured) tags.push('workspace');
      if (state.userConfigured) tags.push('user');
      items.push({
        id: 'install',
        label: '$(gear) Reconfigure Claude Code support…',
        description: `Already configured at ${tags.join(' + ')} scope — re-run to change scope or refresh skill`
      });
      if (!state.userConfigured) {
        items.push({
          id: 'installGlobal',
          label: '$(globe) Make it global (all projects)…',
          description: 'Register at user scope (~/.claude/settings.json) so it works in every workspace'
        });
      }
    }
  } else {
    items.push({
      id: 'installInfo',
      label: '$(info) Claude Code not installed',
      description: 'Install the Anthropic Claude Code extension to enable auto-configuration'
    });
  }

  if (server) {
    items.push({
      id: 'showInfo',
      label: '$(info) Show connection info',
      description: 'Print the server URL'
    });
    items.push({
      id: 'stop',
      label: '$(debug-stop) Stop MCP server',
      description: 'Tear down the local HTTP server'
    });
  }

  items.push({
    id: 'checkUpdate',
    label: '$(cloud-download) Check for updates',
    description: 'Look for a newer release on GitHub'
  });
  items.push({
    id: 'output',
    label: '$(output) Open Debug MCP log',
    description: 'View extension output channel'
  });

  const pick = await vscode.window.showQuickPick(items, {
    title: server ? `Debug MCP (running at ${server.url})` : 'Debug MCP (stopped)',
    placeHolder: 'Pick an action'
  });
  if (!pick) return;

  switch (pick.id) {
    case 'copyUrl':
      await vscode.commands.executeCommand('vscodeDebugMcp.copyUrl');
      break;
    case 'start':
      await startServer();
      break;
    case 'stop':
      await stopServer();
      break;
    case 'install':
      await vscode.commands.executeCommand('vscodeDebugMcp.configureClaudeCode');
      break;
    case 'installGlobal':
      // Same picker as install — the user just selects "User settings" inside it.
      await vscode.commands.executeCommand('vscodeDebugMcp.configureClaudeCode');
      break;
    case 'showInfo':
      await vscode.commands.executeCommand('vscodeDebugMcp.showInfo');
      break;
    case 'output':
      output?.show();
      break;
    case 'installInfo':
      await vscode.env.openExternal(vscode.Uri.parse('vscode:extension/anthropic.claude-code'));
      break;
    case 'checkUpdate':
      await vscode.commands.executeCommand('vscodeDebugMcp.checkForUpdates');
      break;
  }
}

async function startServer() {
  if (server) {
    vscode.window.showInformationMessage(`Debug MCP already running at ${server.url}`);
    return;
  }
  if (!capture) {
    // Should have been created during activate(), but be defensive.
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
    }),
    vscode.commands.registerCommand('vscodeDebugMcp.showMenu', showStatusBarMenu),
    vscode.commands.registerCommand('vscodeDebugMcp.checkForUpdates', async () => {
      await checkForUpdate(context, { force: true });
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

  // Make sure capture is alive so LM tools can read terminal/console buffers
  // even before the user starts the MCP server.
  if (!capture) {
    capture = new CaptureManager(() =>
      vscode.workspace.getConfiguration('vscodeDebugMcp').get<number>('terminalBufferLines', 2000)
    );
  }

  // Register Language Model tools so Copilot Chat (agent mode) and other
  // vscode.lm consumers can call our handlers without going through MCP.
  try {
    registerLmTools(context, capture);
  } catch (err) {
    log(`Failed to register Language Model tools: ${err instanceof Error ? err.message : err}`);
  }

  const autoStart = vscode.workspace.getConfiguration('vscodeDebugMcp').get<boolean>('autoStart', true);
  if (autoStart) {
    await startServer();
  }

  // Background: ask GitHub if there's a newer release.
  void checkForUpdate(context, { silent: true });
}

export function deactivate() {
  return stopServer();
}
