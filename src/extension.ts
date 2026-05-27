import * as vscode from 'vscode';
import { CaptureManager } from './capture';
import { startMcpServer, type RunningServer, type MCPServerEnv } from './mcpServer';
import {
  offerInstall,
  resetInstallPromptFlag,
  getConfigState,
  claudeCodeInstalled,
  uninstallClaudeCodeSupport,
  deactivateCleanup,
  refreshSkillIfInstalled
} from './firstRun';
import { registerLmTools } from './lmTools';
import { checkForUpdate } from './updater';
import { buildLocalToolHandlers, type Tool } from './toolHandlers';
import { SessionRegistry } from './sessionRegistry';
import { setSessionRegistry } from './debugOps';
import {
  Leader,
  Follower,
  probeLeaderHttp,
  workspaceIdFor,
  type WorkspaceInfo
} from './cluster';

let capture: CaptureManager | undefined;
let sessionRegistry: SessionRegistry | undefined;
let server: RunningServer | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let output: vscode.OutputChannel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

let role: 'leader' | 'follower' | 'standalone' = 'standalone';
let leader: Leader | undefined;
let follower: Follower | undefined;
let localHandlers: Record<string, Tool> | undefined;
let ownWorkspace: WorkspaceInfo | undefined;

function computeOwnWorkspace(): WorkspaceInfo {
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
  if (role === 'leader' && server) {
    statusBar.text = `$(debug-alt) MCP :${server.port} (leader)`;
    statusBar.tooltip = `Debug MCP leader — MCP server at ${server.url}\nThis window owns the MCP server; other VS Code windows connect to this one.\nClick for actions.`;
  } else if (role === 'follower') {
    statusBar.text = '$(debug-alt) MCP (follower)';
    statusBar.tooltip = 'Debug MCP follower — registered with the leader window.\nThe leader serves MCP at the configured port; this window\'s workspace is reachable through it.\nClick for actions.';
  } else if (role === 'standalone' && server) {
    statusBar.text = `$(debug-alt) MCP :${server.port}`;
    statusBar.tooltip = `Debug MCP server running at ${server.url}\nClick for actions.`;
  } else {
    statusBar.text = '$(debug-alt) MCP off';
    statusBar.tooltip = 'Debug MCP is stopped. Click for actions.';
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
  } else if (role === 'follower') {
    items.push({
      id: 'info',
      label: '$(link) Following leader window',
      description: `Workspace "${ownWorkspace?.name ?? '?'}" is reachable via the leader's MCP server`
    });
  } else {
    items.push({
      id: 'start',
      label: '$(play) Start MCP server',
      description: 'Bind the local HTTP server (or join an existing leader)'
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
    case 'info':
      // No-op informational item.
      break;
  }
}

async function startServer() {
  if (server || role === 'follower') {
    const where = server ? server.url : 'leader window';
    log(`Start requested but already active (${where})`);
    return;
  }
  if (!capture) {
    capture = new CaptureManager(() =>
      vscode.workspace.getConfiguration('vscodeDebugMcp').get<number>('terminalBufferLines', 2000)
    );
  }
  if (!ownWorkspace) ownWorkspace = computeOwnWorkspace();

  // Try to become leader first. If the port is in use, probe to see if
  // another Debug MCP leader is running; if so, follow it.
  await becomeLeader();
  updateStatusBar();
}

async function becomeLeader(): Promise<void> {
  if (!ownWorkspace) ownWorkspace = computeOwnWorkspace();
  // Set up the cluster IPC server first so it's ready before the HTTP
  // server starts answering /cluster requests.
  leader = new Leader(ownWorkspace, async (tool, args) => runLocalTool(tool, args));
  try {
    await leader.start();
  } catch (err) {
    leader = undefined;
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to start cluster IPC: ${msg}`);
    vscode.window.showErrorMessage(`Debug MCP cluster IPC failed: ${msg}`);
    return;
  }

  leader.on('workspaces-changed', () => {
    log(`Cluster workspaces: ${leader!.listWorkspaces().map((w) => w.name).join(', ')}`);
  });

  const env: MCPServerEnv = {
    dispatch: (workspaceId, tool, args) => leader!.dispatch(workspaceId, tool, args) as Promise<unknown>,
    listWorkspaces: () => leader!.listWorkspaces(),
    defaultWorkspaceId: () => leader!.getOwnWorkspace().id,
    getClusterInfo: () => leader!.getClusterInfo()
  };

  try {
    server = await startMcpServer(env);
    role = 'leader';
    log(`Leader: MCP server listening at ${server.url}`);
    if (extensionContext) {
      void offerInstall(extensionContext, server.url);
    }
  } catch (err: any) {
    if (err?.code === 'EADDRINUSE') {
      // Port is taken — check if it's a fellow Debug MCP leader we can follow.
      const cfg = vscode.workspace.getConfiguration('vscodeDebugMcp');
      const port = cfg.get<number>('port', 6736);
      const host = cfg.get<string>('host', '127.0.0.1');
      log(`Port ${port} is in use; probing for an existing Debug MCP leader…`);
      const info = await probeLeaderHttp(host, port);
      // Clean up our half-built leader either way.
      await leader.stop().catch(() => {});
      leader = undefined;
      if (info) {
        log(`Found Debug MCP leader (pid ${info.pid}); joining as follower via ${info.socket}`);
        await becomeFollower(info.socket);
        return;
      }
      // No Debug MCP responder — somebody else holds the port.
      const msg = `Port ${port} is in use by another process that is not a Debug MCP server. Stop the conflicting process or change vscodeDebugMcp.port in settings.`;
      log(msg);
      vscode.window.showErrorMessage(`Debug MCP: ${msg}`);
      role = 'standalone';
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to start as leader: ${msg}`);
    vscode.window.showErrorMessage(`Failed to start Debug MCP: ${msg}`);
    await leader.stop().catch(() => {});
    leader = undefined;
  }
}

async function becomeFollower(leaderSocketPath: string): Promise<void> {
  if (!ownWorkspace) ownWorkspace = computeOwnWorkspace();
  try {
    follower = new Follower(ownWorkspace, leaderSocketPath, async (tool, args) =>
      runLocalTool(tool, args)
    );
    await follower.connect();
    role = 'follower';
    log(`Follower: registered with leader at ${leaderSocketPath}`);

    follower.on('disconnected', () => {
      log('Follower: leader disconnected. Attempting promotion…');
      follower = undefined;
      role = 'standalone';
      updateStatusBar();
      // Wait a moment then try to become the leader. If multiple
      // followers race, only one will win the port; the others will
      // re-discover and refollow.
      setTimeout(() => {
        void startServer();
      }, 500 + Math.floor(Math.random() * 500));
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`Failed to attach to leader: ${msg}. Trying to become leader.`);
    follower = undefined;
    await becomeLeader();
  }
}

async function stopServer() {
  if (role === 'follower' && follower) {
    await follower.disconnect();
    follower = undefined;
    role = 'standalone';
    log('Follower: disconnected from leader.');
    updateStatusBar();
    return;
  }
  if (server) {
    try {
      await server.stop();
      log('MCP server stopped.');
    } catch (err) {
      log(`Error stopping server: ${err instanceof Error ? err.message : err}`);
    }
    server = undefined;
  }
  if (leader) {
    await leader.stop().catch(() => {});
    leader = undefined;
  }
  role = 'standalone';
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
    }),
    vscode.commands.registerCommand('vscodeDebugMcp.uninstallClaudeCode', async () => {
      const state = await getConfigState();
      const hasWorkspace = state.workspaceConfigured;
      const hasUser = state.userConfigured;

      if (!hasWorkspace && !hasUser) {
        vscode.window.showInformationMessage('Debug MCP: nothing to uninstall — no Claude Code config or skill found.');
        return;
      }

      const items: { label: string; description: string; picked: boolean; value: 'user' | 'workspace' | 'skill' }[] = [];
      if (hasUser) {
        items.push({
          label: '$(globe) User-scope MCP registration',
          description: 'Run `claude mcp remove --scope user vscode-debug`',
          picked: true,
          value: 'user'
        });
      }
      if (hasWorkspace) {
        items.push({
          label: '$(folder) Workspace .mcp.json entry',
          description: 'Remove vscode-debug from this workspace\'s .mcp.json',
          picked: true,
          value: 'workspace'
        });
      }
      items.push({
        label: '$(book) Global skill (~/.claude/skills/debug-mcp/)',
        description: 'Remove the debug-mcp usage skill from your Claude Code config',
        picked: true,
        value: 'skill'
      });

      const picks = await vscode.window.showQuickPick(items, {
        title: 'Uninstall Claude Code Support',
        placeHolder: 'Pick what to remove (use space to toggle)',
        canPickMany: true
      });
      if (!picks || picks.length === 0) return;

      const removed = await uninstallClaudeCodeSupport({
        removeUserMcp: picks.some((p) => p.value === 'user'),
        removeWorkspaceMcp: picks.some((p) => p.value === 'workspace'),
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
  // Best-effort cleanup. We don't await Claude Code config removal —
  // that requires the user to actively confirm via the Uninstall
  // command. Here we only remove the global skill so leaving uninstall
  // residue is minimal.
  await stopServer();
  await deactivateCleanup();
}
