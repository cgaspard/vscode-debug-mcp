import * as path from 'path';

import {
  type HarnessInstaller,
  type HarnessStatus,
  type HarnessContext,
  type ScopeStatus,
  type Scope,
  type InstallResult,
  SERVER_KEY,
  bridgePathFor
} from '../harness';
import { readMcpJson, writeMcpJsonEntry, removeMcpJsonEntry, entryMatches } from './mcpJson';

/**
 * Harness-agnostic project installer: writes a portable `.mcp.json` at the repo
 * root using the `mcpServers` convention that VS Code's native agent and many
 * MCP clients read. Project-only — a global `.mcp.json` has no well-defined
 * home, so user scope is intentionally unsupported.
 */
function configPath(projectDir: string): string {
  return path.join(projectDir, '.mcp.json');
}

export class GenericMcpInstaller implements HarnessInstaller {
  readonly id = 'generic' as const;
  readonly displayName = 'Generic (.mcp.json)';
  readonly blurb = 'Portable .mcp.json at the repo root — read by VS Code\'s built-in agent and other MCP clients. Project scope only.';
  readonly scopes = ['project'] as const;

  async status(ctx: HarnessContext): Promise<HarnessStatus> {
    // No tool to detect — treat as "available" whenever a workspace is open.
    const detected = Boolean(ctx.projectDir);
    let project: ScopeStatus | undefined;
    if (ctx.projectDir) {
      const file = configPath(ctx.projectDir);
      const bridgePath = bridgePathFor(ctx.extensionPath);
      const existing = await readMcpJson(file).catch(() => undefined);
      const entry = existing?.parsed.mcpServers?.[SERVER_KEY];
      project = {
        configured: entry !== undefined,
        stale: entry !== undefined ? !entryMatches(entry, bridgePath) : false,
        configPath: file,
        detail: 'Committed to the repo; any MCP client can pick it up'
      };
    }
    // user is unused for this harness but the shape requires it.
    const user: ScopeStatus = { configured: false, stale: false, configPath: '(not applicable — project only)' };
    return { detected, user, project };
  }

  async install(ctx: HarnessContext, scope: Scope): Promise<InstallResult> {
    if (scope !== 'project') return { ok: false, error: 'The generic .mcp.json target is project-scope only.' };
    if (!ctx.projectDir) return { ok: false, error: 'No workspace folder is open.' };
    const file = configPath(ctx.projectDir);
    try {
      const result = await writeMcpJsonEntry(file, bridgePathFor(ctx.extensionPath));
      return { ok: true, messages: [`${result === 'created' ? 'Wrote' : 'Updated'} .mcp.json at the repo root`] };
    } catch (err) {
      return { ok: false, error: `Could not write ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  async uninstall(ctx: HarnessContext, scope: Scope): Promise<InstallResult> {
    if (scope !== 'project') return { ok: false, error: 'The generic .mcp.json target is project-scope only.' };
    if (!ctx.projectDir) return { ok: false, error: 'No workspace folder is open.' };
    const file = configPath(ctx.projectDir);
    try {
      const removed = await removeMcpJsonEntry(file);
      return { ok: true, messages: [removed ? 'Removed vscode-debug from .mcp.json' : 'vscode-debug was not in .mcp.json'] };
    } catch (err) {
      return { ok: false, error: `Could not write ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
