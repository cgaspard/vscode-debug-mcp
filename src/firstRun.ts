import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const CLAUDE_CODE_EXT_ID = 'anthropic.claude-code';
const SERVER_KEY = 'vscode-debug';
const SKILL_NAME = 'debug-mcp';
// 'declined' means the user explicitly chose "Don't ask again". We never
// auto-prompt them again until they run Reset Install Prompt. Any other
// value (including undefined) means we'll auto-prompt whenever the
// current workspace isn't configured AND user scope isn't configured.
const PROMPTED_KEY = 'debugMcp.installPromptDeclined';

interface McpJson {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

interface ClaudeUserConfig {
  mcpServers?: Record<string, { type?: string; url?: string }>;
  [k: string]: unknown;
}

function entryForUrl(url: string) {
  return { type: 'http' as const, url };
}

async function readJsonIfExists(file: string): Promise<McpJson | undefined> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as McpJson;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return undefined;
    throw err;
  }
}

async function writeMergedMcpJson(file: string, url: string): Promise<'created' | 'updated' | 'unchanged'> {
  const existing = (await readJsonIfExists(file)) ?? {};
  const servers = (existing.mcpServers ?? {}) as Record<string, unknown>;
  const desired = entryForUrl(url);
  const current = servers[SERVER_KEY] as { type?: string; url?: string } | undefined;
  if (current && current.type === desired.type && current.url === desired.url) {
    return 'unchanged';
  }
  servers[SERVER_KEY] = desired;
  const next: McpJson = { ...existing, mcpServers: servers };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return existing.mcpServers ? 'updated' : 'created';
}

async function writeSkill(skillDir: string, sourceFile: string): Promise<'created' | 'updated'> {
  const targetFile = path.join(skillDir, 'SKILL.md');
  const desired = await fs.readFile(sourceFile, 'utf8');
  let existed = false;
  try {
    const current = await fs.readFile(targetFile, 'utf8');
    if (current === desired) return 'updated';
    existed = true;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(targetFile, desired, 'utf8');
  return existed ? 'updated' : 'created';
}

/**
 * Register the MCP server at user scope by shelling out to `claude mcp
 * add --scope user`. We use the CLI rather than editing ~/.claude.json
 * directly because the storage format is owned by Claude Code and can
 * change between versions.
 */
async function registerUserScope(url: string): Promise<'created' | 'updated' | 'unchanged'> {
  const wasConfigured = await isUserScopeConfigured(url);
  if (wasConfigured === 'matches') return 'unchanged';

  // If a different URL is already registered, remove it first so `add`
  // doesn't fail with "already exists".
  if (wasConfigured === 'mismatch') {
    try {
      await execAsync(`claude mcp remove --scope user ${SERVER_KEY}`);
    } catch {
      /* fall through; add will surface a clear error if needed */
    }
  }

  const cmd = `claude mcp add --scope user --transport http ${SERVER_KEY} ${shellQuote(url)}`;
  try {
    await execAsync(cmd);
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() ?? '';
    throw new Error(
      stderr || err?.message || `claude mcp add failed (is the 'claude' CLI on PATH?)`
    );
  }
  return wasConfigured === 'missing' ? 'created' : 'updated';
}

function shellQuote(s: string): string {
  // Conservative: single-quote and escape embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function isUserScopeConfigured(expectedUrl: string): Promise<'matches' | 'mismatch' | 'missing'> {
  // Read ~/.claude.json directly to determine the current state without
  // assuming the CLI's exit codes/output format.
  const file = path.join(os.homedir(), '.claude.json');
  try {
    const raw = await fs.readFile(file, 'utf8');
    const data = JSON.parse(raw) as ClaudeUserConfig;
    const entry = data.mcpServers?.[SERVER_KEY];
    if (!entry) return 'missing';
    if (entry.url === expectedUrl && entry.type === 'http') return 'matches';
    return 'mismatch';
  } catch (err: any) {
    if (err?.code === 'ENOENT') return 'missing';
    return 'missing';
  }
}

async function isWorkspaceScopeConfigured(): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return false;
  const json = await readJsonIfExists(path.join(folder.uri.fsPath, '.mcp.json'));
  if (!json) return false;
  const servers = (json.mcpServers ?? {}) as Record<string, unknown>;
  return Boolean(servers[SERVER_KEY]);
}

export function claudeCodeInstalled(): boolean {
  return Boolean(vscode.extensions.getExtension(CLAUDE_CODE_EXT_ID));
}

export interface ConfigState {
  workspaceConfigured: boolean;
  userConfigured: boolean;
}

export async function getConfigState(): Promise<ConfigState> {
  // Best-effort URL we expect — using the user's current configured URL
  // would require server.url; for state purposes only "is there an entry"
  // matters. We treat any vscode-debug entry as configured.
  const [workspaceConfigured, userConfigured] = await Promise.all([
    isWorkspaceScopeConfigured(),
    isUserScopeConfigured('').then((s) => s !== 'missing')
  ]);
  return { workspaceConfigured, userConfigured };
}

type Scope = 'workspace' | 'user';

interface InstallTarget {
  label: string;
  description: string;
  detail: string;
  scope: Scope;
}

function globalSkillDir(): string {
  return path.join(os.homedir(), '.claude', 'skills', SKILL_NAME);
}

function targets(): InstallTarget[] {
  const out: InstallTarget[] = [];
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const root = folder.uri.fsPath;
    out.push({
      label: 'This workspace',
      description: 'Add .mcp.json to the project (shared with collaborators via git).',
      detail: `MCP: ${path.join(root, '.mcp.json')}`,
      scope: 'workspace'
    });
  }
  out.push({
    label: 'User settings (all projects)',
    description: 'Register via `claude mcp add --scope user` so it works in every workspace.',
    detail: `Registers vscode-debug at user scope via the Claude Code CLI.`,
    scope: 'user'
  });
  return out;
}

export async function offerInstall(
  context: vscode.ExtensionContext,
  serverUrl: string,
  opts: { force?: boolean } = {}
): Promise<void> {
  if (!opts.force) {
    if (!claudeCodeInstalled()) return;
    if (context.globalState.get<boolean>(PROMPTED_KEY)) return; // explicit "Don't ask again"

    // Check current configuration state. If the user is already
    // configured globally OR in this workspace, don't re-prompt.
    const state = await getConfigState();
    if (state.userConfigured) return;
    if (state.workspaceConfigured) return;
  }

  const choices = ['Configure…', "Don't ask again", 'Not now'] as const;
  const message = opts.force
    ? `Configure Claude Code to use Debug MCP at ${serverUrl}?`
    : `Claude Code is installed. Configure it to use this extension's MCP server (${serverUrl})?`;

  const answer = await vscode.window.showInformationMessage(message, ...choices);

  if (answer === "Don't ask again") {
    await context.globalState.update(PROMPTED_KEY, true);
    return;
  }
  if (answer !== 'Configure…') return;

  const items = targets().map((t) => ({
    label: t.label,
    description: t.description,
    detail: t.detail,
    target: t
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Where should Debug MCP be registered?',
    placeHolder: 'Pick a scope (applies to both MCP config and skill)'
  });
  if (!pick) return;

  const includeSkill = await vscode.window.showQuickPick(
    [
      { label: 'Yes (recommended)', description: 'Install the debug-mcp usage skill globally (~/.claude/skills/) so Claude knows how to drive these tools well.', value: true },
      { label: 'No', description: 'Only register the MCP server.', value: false }
    ],
    {
      title: 'Also install the debug-mcp usage skill?',
      placeHolder: 'The skill is a markdown file Claude auto-loads when relevant. Installed globally so it activates in any workspace.'
    }
  );
  if (!includeSkill) return; // user dismissed

  const written: string[] = [];

  try {
    if (pick.target.scope === 'workspace') {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) throw new Error('No workspace open.');
      const file = path.join(folder.uri.fsPath, '.mcp.json');
      const result = await writeMergedMcpJson(file, serverUrl);
      written.push(`${result === 'created' ? 'Created' : result === 'updated' ? 'Updated' : 'Verified'} ${file}`);
    } else {
      const result = await registerUserScope(serverUrl);
      const verbMap = { created: 'Added', updated: 'Updated', unchanged: 'Already registered' };
      written.push(`${verbMap[result]} vscode-debug at user scope (via 'claude mcp add')`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to configure Claude Code: ${msg}`);
    return;
  }

  // Skill always goes to the user-scope location. It's generic guidance,
  // not project-specific, and skills are description-gated so a global
  // install only activates when relevant.
  if (includeSkill.value) {
    const skillDir = globalSkillDir();
    const sourceSkill = path.join(context.extensionPath, 'resources', 'skill', 'SKILL.md');
    try {
      const skillResult = await writeSkill(skillDir, sourceSkill);
      written.push(`${skillResult === 'created' ? 'Installed' : 'Updated'} skill at ${skillDir}/SKILL.md`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`MCP config written, but skill install failed: ${msg}`);
    }
  }

  // We intentionally do NOT set PROMPTED_KEY here. The next workspace
  // the user opens that lacks vscode-debug should still trigger a
  // prompt — unless user-scope is configured, which getConfigState()
  // will detect.

  await vscode.window.showInformationMessage(
    `${written.join('. ')}. Reload Claude Code to pick up changes.`
  );
}

/**
 * Remove user-scope MCP registration and the global skill. Best-effort —
 * we surface failures but don't throw. Used by the explicit uninstall
 * command and by deactivate() as a safety net.
 */
export async function uninstallClaudeCodeSupport(opts: {
  removeUserMcp: boolean;
  removeSkill: boolean;
  removeWorkspaceMcp?: boolean;
}): Promise<string[]> {
  const removed: string[] = [];

  if (opts.removeUserMcp) {
    try {
      await execAsync(`claude mcp remove --scope user ${SERVER_KEY}`);
      removed.push(`Unregistered vscode-debug at user scope`);
    } catch (err: any) {
      const stderr = err?.stderr?.toString?.() ?? '';
      // 'not found' is fine — already absent is success for our purposes.
      if (/not found|does not exist|no such/i.test(stderr) || /not found/i.test(err?.message ?? '')) {
        removed.push(`vscode-debug was not registered at user scope`);
      } else {
        removed.push(`(Failed to unregister user scope: ${stderr || err?.message})`);
      }
    }
  }

  if (opts.removeSkill) {
    const skillDir = globalSkillDir();
    try {
      await fs.rm(skillDir, { recursive: true, force: true });
      removed.push(`Removed ${skillDir}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      removed.push(`(Failed to remove skill: ${msg})`);
    }
  }

  if (opts.removeWorkspaceMcp) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      const file = path.join(folder.uri.fsPath, '.mcp.json');
      try {
        const existing = await readJsonIfExists(file);
        if (existing?.mcpServers && (existing.mcpServers as any)[SERVER_KEY]) {
          delete (existing.mcpServers as any)[SERVER_KEY];
          // If mcpServers is now empty, drop the whole key to keep things tidy.
          if (Object.keys(existing.mcpServers).length === 0) {
            delete existing.mcpServers;
          }
          if (Object.keys(existing).length === 0) {
            // Empty file — delete it
            await fs.unlink(file);
            removed.push(`Removed ${file} (was empty after removal)`);
          } else {
            await fs.writeFile(file, JSON.stringify(existing, null, 2) + '\n', 'utf8');
            removed.push(`Removed vscode-debug entry from ${file}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        removed.push(`(Failed to update ${file}: ${msg})`);
      }
    }
  }

  return removed;
}

/**
 * Best-effort cleanup on extension deactivation. Removes the global
 * skill only — leaves MCP registration alone since the user may have
 * other tooling pointing at the same server config.
 */
export async function deactivateCleanup(): Promise<void> {
  try {
    await fs.rm(globalSkillDir(), { recursive: true, force: true });
  } catch {
    /* ignore — best-effort */
  }
}

export async function resetInstallPromptFlag(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(PROMPTED_KEY, false);
}

/**
 * On extension activation/upgrade, if a debug-mcp skill is already
 * installed at ~/.claude/skills/debug-mcp/, refresh it from the bundled
 * copy. This keeps SKILL.md in sync with whatever shipped in the
 * current .vsix without requiring the user to re-run the installer.
 *
 * Idempotent: writeSkill() compares bytes and is a no-op if unchanged.
 * Does nothing if the user hasn't installed the skill yet.
 */
export async function refreshSkillIfInstalled(extensionPath: string): Promise<'updated' | 'unchanged' | 'not-installed'> {
  const skillDir = globalSkillDir();
  const targetFile = path.join(skillDir, 'SKILL.md');
  try {
    await fs.stat(targetFile);
  } catch {
    return 'not-installed';
  }
  const sourceSkill = path.join(extensionPath, 'resources', 'skill', 'SKILL.md');
  try {
    const desired = await fs.readFile(sourceSkill, 'utf8');
    const current = await fs.readFile(targetFile, 'utf8');
    if (current === desired) return 'unchanged';
    await fs.writeFile(targetFile, desired, 'utf8');
    return 'updated';
  } catch {
    return 'not-installed';
  }
}
