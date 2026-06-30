import * as vscode from 'vscode';
import { bridgePathFor, bridgeInvocation } from './harness';

/**
 * Surfaces our per-window MCP server to VS Code's OWN MCP machinery (the native
 * "MCP Servers" settings UI and the built-in Copilot agent), so the user never
 * has to hand-write an mcp.json entry.
 *
 * This is purely additive and reuses the SAME bridge invocation
 * (`bridgeInvocation` in harness.ts) that every harness installer registers, so
 * the discovery paths can never drift. VS Code spawns `out/bridge.js` via the
 * extension-host Node (process.execPath + ELECTRON_RUN_AS_NODE=1); the bridge
 * then resolves this window's socket at runtime exactly as it does for the
 * external CLIs. See harness.ts:bridgeInvocation for why the ELECTRON_RUN_AS_NODE
 * flag is mandatory rather than optional.
 *
 * Requires VS Code 1.101+ (the engine floor was bumped for this). The call is
 * still guarded so a host that somehow lacks the API degrades to lm-tools-only
 * instead of throwing during activation.
 */
export function registerMcpProvider(context: vscode.ExtensionContext): void {
  if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function') {
    return;
  }

  const provider = vscode.lm.registerMcpServerDefinitionProvider(
    'vscode-debug-mcp.provider',
    {
      provideMcpServerDefinitions(): vscode.McpStdioServerDefinition[] {
        const inv = bridgeInvocation(bridgePathFor(context.extensionPath));
        const def = new vscode.McpStdioServerDefinition(
          'VS Code Debug MCP',
          inv.command,
          inv.args,
          inv.env,
          // Tie the definition version to the extension version so VS Code
          // re-probes the tool list after an upgrade (the bridge path embeds
          // the install dir, which changes on every version bump).
          context.extension.packageJSON.version as string
        );
        return [def];
      }
    }
  );

  context.subscriptions.push(provider);
}
