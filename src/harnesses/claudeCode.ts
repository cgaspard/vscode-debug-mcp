import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

import {
  type HarnessInstaller,
  type HarnessStatus,
  type HarnessContext,
  type ScopeStatus,
  type Scope,
  type InstallResult,
  SERVER_KEY,
  bridgeInvocation,
  bridgePathFor
} from '../harness';
import {
  bundledSkillSource,
  globalSkillDir,
  skillIsInstalled,
  writeSkill,
  removeSkill
} from '../firstRun';
import { readMcpJson, entryMatches as mcpJsonMatches } from './mcpJson';

const execAsync = promisify(exec);
const CLAUDE_CODE_EXT_ID = 'anthropic.claude-code';

interface ClaudeMcpEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

interface ClaudeUserConfig {
  mcpServers?: Record<string, ClaudeMcpEntry>;
  [k: string]: unknown;
}

function userConfigPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

/** Project scope writes a shared .mcp.json at the repo root. */
function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, '.mcp.json');
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function readUserConfig(): Promise<ClaudeUserConfig | undefined> {
  try {
    return JSON.parse(await fs.readFile(userConfigPath(), 'utf8')) as ClaudeUserConfig;
  } catch {
    return undefined;
  }
}

function desiredClaudeEntry(bridgePath: string): ClaudeMcpEntry {
  const inv = bridgeInvocation(bridgePath);
  return { type: 'stdio', command: inv.command, args: inv.args, env: inv.env };
}

function userEntryMatches(entry: ClaudeMcpEntry, bridgePath: string): boolean {
  const desired = desiredClaudeEntry(bridgePath);
  return (
    entry.type === desired.type &&
    entry.command === desired.command &&
    Array.isArray(entry.args) &&
    entry.args[0] === desired.args?.[0] &&
    // Pre-fix installs lack ELECTRON_RUN_AS_NODE, which makes the Electron
    // command open bridge.js in the editor instead of running it.
    entry.env?.ELECTRON_RUN_AS_NODE === desired.env?.ELECTRON_RUN_AS_NODE
  );
}

export class ClaudeCodeInstaller implements HarnessInstaller {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude Code';
  readonly blurb = 'Anthropic Claude Code (VS Code extension). User scope registers an stdio bridge; project scope writes a shared .mcp.json.';
  readonly scopes = ['user', 'project'] as const;

  async status(ctx: HarnessContext): Promise<HarnessStatus> {
    const detected = Boolean(vscode.extensions.getExtension(CLAUDE_CODE_EXT_ID));
    const bridgePath = bridgePathFor(ctx.extensionPath);

    const userEntry = (await readUserConfig())?.mcpServers?.[SERVER_KEY];
    const skill = await skillIsInstalled();
    const user: ScopeStatus = {
      configured: userEntry !== undefined,
      stale: userEntry !== undefined ? !userEntryMatches(userEntry, bridgePath) : false,
      configPath: userConfigPath(),
      detail: skill ? `Usage skill installed (${globalSkillDir()})` : 'Usage skill not installed'
    };

    let project: ScopeStatus | undefined;
    if (ctx.projectDir) {
      const file = projectConfigPath(ctx.projectDir);
      const proj = await readMcpJson(file).catch(() => undefined);
      const entry = proj?.parsed.mcpServers?.[SERVER_KEY];
      project = {
        configured: entry !== undefined,
        stale: entry !== undefined ? !mcpJsonMatches(entry, bridgePath) : false,
        configPath: file
      };
    }

    return { detected, user, project };
  }

  async skillInstalled(): Promise<boolean> {
    return skillIsInstalled();
  }

  async install(ctx: HarnessContext, scope: Scope): Promise<InstallResult> {
    return scope === 'user'
      ? this.installUser(ctx, true)
      : this.installProject(ctx);
  }

  /** User scope, with optional skill (Claude-only). */
  async installUser(ctx: HarnessContext, includeSkill: boolean): Promise<InstallResult> {
    const messages: string[] = [];
    const bridgePath = bridgePathFor(ctx.extensionPath);
    const existed = (await readUserConfig())?.mcpServers?.[SERVER_KEY] !== undefined;

    await execAsync(`claude mcp remove --scope user ${SERVER_KEY}`).catch(() => {});
    const json = JSON.stringify(desiredClaudeEntry(bridgePath));
    try {
      await execAsync(`claude mcp add-json --scope user ${SERVER_KEY} ${shellQuote(json)}`);
    } catch (err: any) {
      const stderr = err?.stderr?.toString?.() ?? '';
      return { ok: false, error: stderr || err?.message || `claude mcp add-json failed (is the 'claude' CLI on PATH?)` };
    }
    messages.push(existed ? 'Updated user-scope registration' : 'Registered at user scope');

    if (includeSkill) {
      try {
        const result = await writeSkill(globalSkillDir(), bundledSkillSource(ctx.extensionPath));
        messages.push(`${result === 'created' ? 'Installed' : 'Updated'} usage skill`);
      } catch (err) {
        messages.push(`(skill install failed: ${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return { ok: true, messages };
  }

  /** Project scope: shared .mcp.json at the repo root. */
  async installProject(ctx: HarnessContext): Promise<InstallResult> {
    if (!ctx.projectDir) return { ok: false, error: 'No workspace folder is open.' };
    const file = projectConfigPath(ctx.projectDir);
    const had = (await readMcpJson(file).catch(() => undefined))?.parsed.mcpServers?.[SERVER_KEY] !== undefined;
    // Run the CLI scoped to the project dir so Claude owns the .mcp.json format.
    const json = JSON.stringify(desiredClaudeEntry(bridgePathFor(ctx.extensionPath)));
    await execAsync(`claude mcp remove --scope project ${SERVER_KEY}`, { cwd: ctx.projectDir }).catch(() => {});
    try {
      await execAsync(`claude mcp add-json --scope project ${SERVER_KEY} ${shellQuote(json)}`, { cwd: ctx.projectDir });
    } catch (err: any) {
      const stderr = err?.stderr?.toString?.() ?? '';
      return { ok: false, error: stderr || err?.message || `claude mcp add-json --scope project failed` };
    }
    return { ok: true, messages: [`${had ? 'Updated' : 'Wrote'} ${path.basename(file)} in the project (shared, committed)`] };
  }

  async uninstall(ctx: HarnessContext, scope: Scope): Promise<InstallResult> {
    return scope === 'user'
      ? this.uninstallUser({ removeMcp: true, removeSkill: true })
      : this.uninstallProject(ctx);
  }

  async uninstallUser(opts: { removeMcp: boolean; removeSkill: boolean }): Promise<InstallResult> {
    const messages: string[] = [];
    if (opts.removeMcp) {
      try {
        await execAsync(`claude mcp remove --scope user ${SERVER_KEY}`);
        messages.push('Unregistered at user scope');
      } catch (err: any) {
        const stderr = err?.stderr?.toString?.() ?? '';
        if (/not found|does not exist|no such/i.test(stderr) || /not found/i.test(err?.message ?? '')) {
          messages.push('Was not registered at user scope');
        } else {
          messages.push(`(failed to unregister: ${stderr || err?.message})`);
        }
      }
    }
    if (opts.removeSkill) {
      try {
        await removeSkill();
        messages.push('Removed usage skill');
      } catch (err) {
        messages.push(`(failed to remove skill: ${err instanceof Error ? err.message : String(err)})`);
      }
    }
    return { ok: true, messages };
  }

  async uninstallProject(ctx: HarnessContext): Promise<InstallResult> {
    if (!ctx.projectDir) return { ok: false, error: 'No workspace folder is open.' };
    try {
      await execAsync(`claude mcp remove --scope project ${SERVER_KEY}`, { cwd: ctx.projectDir });
    } catch (err: any) {
      const stderr = err?.stderr?.toString?.() ?? '';
      if (/not found|does not exist|no such/i.test(stderr) || /not found/i.test(err?.message ?? '')) {
        return { ok: true, messages: ['Was not in the project .mcp.json'] };
      }
      return { ok: false, error: stderr || err?.message || 'claude mcp remove --scope project failed' };
    }
    return { ok: true, messages: ['Removed from the project .mcp.json'] };
  }
}
