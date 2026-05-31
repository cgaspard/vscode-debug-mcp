import * as vscode from 'vscode';
import * as path from 'path';
import { CaptureManager } from './capture';
import { type MCPServerEnv } from './mcpServer';
import {
  offerInstall,
  registerStdioBridge,
  resetInstallPromptFlag,
  getConfigState,
  claudeCodeInstalled,
  uninstallClaudeCodeSupport,
  deactivateCleanup,
  refreshSkillIfInstalled,
  isStdioBridgeStale
} from './firstRun';
import { registerLmTools } from './lmTools';
import { startUdsServer, type RunningUdsServer, workspaceIdFor } from './udsServer';
import { checkForUpdate } from './updater';
import { buildLocalToolHandlers, type Tool } from './toolHandlers';
import { SessionRegistry } from './sessionRegistry';
import { setSessionRegistry } from './debugOps';

let capture: CaptureManager | undefined;
let sessionRegistry: SessionRegistry | undefined;
let server: RunningUdsServer | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let localHandlers: Record<string, Tool> | undefined;

interface OwnWorkspace {
  id: string;
  name: string;
  path: string;
}

function computeOwnWorkspace(): OwnWorkspace {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const absPath = folder?.uri.fsPath ?? `<no-workspace:${process.pid}>`;
  const name = folder?.name ?? `(no workspace, pid ${process.pid})`;
  return { id: workspaceIdFor(absPath), name, path: absPath };
}

function runLocalTool(tool: string, args: any): Promise<unknown> | unknown {
  const handlers = localHandlers ?? (localHandlers = buildLocalToolHandlers(capture!));
  const handler = handlers[tool];
  if (!handler) throw new Error(`Unknown tool: ${tool}`);
  return handler(args ?? {});
}

function log(msg: string) {
  if (!output) output = vscode.window.createOutputChannel('Debug MCP');
  const ts = new Date().toISOString();
  output.appendLine(`[${ts}] ${msg}`);
}

function updateStatusBar() {
  if (!statusBar) return;
  if (server) {
    statusBar.text = '$(debug-alt) Debug MCP';
    statusBar.tooltip =
      `Debug MCP listening for this window at\n${server.socketPath}\n` +
      `Claude Code reaches it via the stdio bridge.\nClick for actions.`;
  } else {
    statusBar.text = '$(debug-alt) MCP off';
    statusBar.tooltip = 'Debug MCP is stopped. Click for actions.';
  }
  statusBar.command = 'vscodeDebugMcp.showMenu';
  statusBar.show();
}

/**
 * Start the per-window MCP server. Each VS Code window binds its OWN Unix
 * socket (named from its workspace folder), so there is no shared port and no
 * leader/follower routing — every tool call resolves to THIS window. A stdio
 * bridge that `claude` spawns connects to this window's socket.
 */
async function startServer() {
  if (server) {
    log(`Start requested but already listening at ${server.socketPath}`);
    return;
  }
  if (!capture) {
    capture = new CaptureManager(() =>
      vscode.workspace.getConfiguration('vscodeDebugMcp').get<number>('terminalBufferLines', 2000)
    );
  }
  const own = computeOwnWorkspace();
  const env: MCPServerEnv = {
    dispatch: (_workspaceId, tool, args) => Promise.resolve(runLocalTool(tool, args)),
    listWorkspaces: () => [own],
    defaultWorkspaceId: () => own.id
  };
  try {
    server = await startUdsServer(env, own.path);
    log(`MCP server listening at ${server.socketPath}`);
    if (extensionContext) {
      void offerInstall(extensionContext);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to start MCP server: ${msg}`);
    vscode.window.showErrorMessage(`Failed to start Debug MCP: ${msg}`);
  }
  updateStatusBar();
}

async function stopServer() {
  if (server) {
    try {
      await server.stop();
      log('MCP server stopped.');
    } catch (err) {
      log(`Error stopping server: ${err instanceof Error ? err.message : err}`);
    }
    server = undefined;
  }
  updateStatusBar();
}

async function showStatusBarMenu() {
  const state = await getConfigState();
  const hasClaude = claudeCodeInstalled();

  type Item = vscode.QuickPickItem & { id: string };
  const items: Item[] = [];

  if (server) {
    items.push({
      id: 'showInfo',
      label: '$(info) Show connection info',
      description: server.socketPath
    });
  } else {
    items.push({
      id: 'start',
      label: '$(play) Start MCP server',
      description: 'Bind this window\'s socket'
    });
  }

  if (hasClaude) {
    if (!state.userConfigured) {
      items.push({
        id: 'install',
        label: '$(rocket) Install Claude Code support…',
        description: 'Register the stdio bridge and (optionally) the usage skill'
      });
    } else {
      items.push({
        id: 'install',
        label: '$(gear) Reconfigure Claude Code support…',
        description: 'Already configured — re-run to refresh the bridge registration or skill'
      });
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
      id: 'stop',
      label: '$(debug-stop) Stop MCP server',
      description: 'Tear down this window\'s socket'
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
    title: server ? 'Debug MCP (running)' : 'Debug MCP (stopped)',
    placeHolder: 'Pick an action'
  });
  if (!pick) return;

  switch (pick.id) {
    case 'start':
      await startServer();
      break;
    case 'stop':
      await stopServer();
      break;
    case 'install':
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
      vscode.window.showInformationMessage(`Debug MCP listening at ${server.socketPath}`);
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
      await offerInstall(context, { force: true });
    }),
    vscode.commands.registerCommand('vscodeDebugMcp.resetInstallPrompt', async () => {
      await resetInstallPromptFlag(context);
      vscode.window.showInformationMessage('Debug MCP: install prompt will show again next activation.');
    }),
    vscode.commands.registerCommand('vscodeDebugMcp.showMenu', showStatusBarMenu),
    vscode.commands.registerCommand('vscodeDebugMcp.checkForUpdates', async () => {
      await checkForUpdate(context, { force: true });
    }),
    vscode.commands.registerCommand('vscodeDebugMcp.uninstallClaudeCode', async () => {
      const state = await getConfigState();
      if (!state.userConfigured && !state.skillInstalled) {
        vscode.window.showInformationMessage('Debug MCP: nothing to uninstall — no Claude Code config or skill found.');
        return;
      }

      const items: { label: string; description: string; picked: boolean; value: 'user' | 'skill' }[] = [];
      if (state.userConfigured) {
        items.push({
          label: '$(globe) MCP registration',
          description: 'Run `claude mcp remove --scope user vscode-debug`',
          picked: true,
          value: 'user'
        });
      }
      if (state.skillInstalled) {
        items.push({
          label: '$(book) Global skill (~/.claude/skills/debug-mcp/)',
          description: 'Remove the debug-mcp usage skill from your Claude Code config',
          picked: true,
          value: 'skill'
        });
      }

      const picks = await vscode.window.showQuickPick(items, {
        title: 'Uninstall Claude Code Support',
        placeHolder: 'Pick what to remove (use space to toggle)',
        canPickMany: true
      });
      if (!picks || picks.length === 0) return;

      const removed = await uninstallClaudeCodeSupport({
        removeUserMcp: picks.some((p) => p.value === 'user'),
        removeSkill: picks.some((p) => p.value === 'skill')
      });
      await vscode.window.showInformationMessage(
        `${removed.join('. ') || 'Nothing to remove.'} Reload Claude Code to pick up changes.`
      );
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

  // Track every debug session — including ones the user starts via F5
  // without going through the AI. The registry feeds list_debug_sessions
  // and get_last_stopped_event.
  if (!sessionRegistry) {
    sessionRegistry = new SessionRegistry();
    setSessionRegistry(sessionRegistry);
    context.subscriptions.push(sessionRegistry);
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

  // Self-heal: the registered bridge path embeds this extension's install dir,
  // which changes on every version bump. If Claude Code is already configured
  // but points at a stale bridge.js, silently re-point it at the current one.
  const bridgePath = path.join(context.extensionPath, 'out', 'bridge.js');
  void isStdioBridgeStale(bridgePath)
    .then(async (stale) => {
      if (stale) {
        await registerStdioBridge(bridgePath);
        log('Re-pointed the Claude Code stdio bridge at the current extension build.');
      }
    })
    .catch((err) => log(`Bridge self-heal check failed: ${err instanceof Error ? err.message : err}`));

  // Background: ask GitHub if there's a newer release.
  void checkForUpdate(context, { silent: true });

  // Background: if the user has previously installed the skill, keep
  // it in sync with whatever ships in this version of the extension.
  void refreshSkillIfInstalled(context.extensionPath)
    .then((result) => {
      if (result === 'updated') {
        log('Refreshed user-scope debug-mcp skill from bundled copy.');
      }
    })
    .catch((err) => {
      log(`Skill refresh failed: ${err instanceof Error ? err.message : err}`);
    });
}

export async function deactivate() {
  // Best-effort cleanup. We don't remove Claude Code config — that requires
  // the user to actively confirm via the Uninstall command. Here we only
  // remove the global skill so leaving uninstall residue is minimal.
  await stopServer();
  await deactivateCleanup();
}
