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
// value (including undefined) means we'll auto-prompt whenever Claude Code
// isn't configured at user scope.
const PROMPTED_KEY = 'debugMcp.installPromptDeclined';

interface ClaudeUserConfig {
  mcpServers?: Record<string, ClaudeMcpEntry>;
  [k: string]: unknown;
}

interface ClaudeMcpEntry {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
}

function bridgePathFor(extensionPath: string): string {
  return path.join(extensionPath, 'out', 'bridge.js');
}

function shellQuote(s: string): string {
  // Conservative: single-quote and escape embedded single quotes.
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The desired stdio entry: spawn the bridge with the Node that runs VS Code's
 * extension host. The bridge resolves its own per-window socket at runtime, so
 * a single user-scope entry works in every workspace.
 */
function desiredEntry(bridgePath: string): ClaudeMcpEntry {
  return { type: 'stdio', command: process.execPath, args: [bridgePath] };
}

async function readUserConfig(): Promise<ClaudeUserConfig | undefined> {
  const file = path.join(os.homedir(), '.claude.json');
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as ClaudeUserConfig;
  } catch (err: any) {
    if (err?.code === 'ENOENT') return undefined;
    return undefined;
  }
}

/**
 * Register (or re-register) the stdio bridge at user scope via the Claude Code
 * CLI. We shell out rather than editing ~/.claude.json directly because the
 * storage format is owned by Claude Code. Idempotent: removes any prior entry
 * (http or stale stdio) first, then adds the current one. Replaces in place
 * under the same SERVER_KEY so the mcp__vscode-debug__* tool prefix is stable.
 */
export async function registerStdioBridge(bridgePath: string): Promise<'created' | 'updated'> {
  const existed = (await readUserConfig())?.mcpServers?.[SERVER_KEY] !== undefined;

  // Remove any prior entry (http URL or stale stdio path) so `add` is clean.
  await execAsync(`claude mcp remove --scope user ${SERVER_KEY}`).catch(() => {});

  const entry = desiredEntry(bridgePath);
  const json = JSON.stringify(entry);
  try {
    await execAsync(`claude mcp add-json --scope user ${SERVER_KEY} ${shellQuote(json)}`);
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() ?? '';
    throw new Error(stderr || err?.message || `claude mcp add-json failed (is the 'claude' CLI on PATH?)`);
  }
  return existed ? 'updated' : 'created';
}

/**
 * True when Claude Code already has a vscode-debug entry but it does NOT point
 * at the current bridge path (e.g. an old extension version's path, or the
 * legacy http entry). Used by the activation self-heal to silently re-point.
 * False when there's no entry at all (nothing to heal — let the user install)
 * or when it already matches.
 */
export async function isStdioBridgeStale(bridgePath: string): Promise<boolean> {
  const entry = (await readUserConfig())?.mcpServers?.[SERVER_KEY];
  if (!entry) return false;
  const desired = desiredEntry(bridgePath);
  const matches =
    entry.type === desired.type &&
    entry.command === desired.command &&
    Array.isArray(entry.args) &&
    entry.args[0] === desired.args?.[0];
  return !matches;
}

async function isUserScopeConfigured(): Promise<boolean> {
  return (await readUserConfig())?.mcpServers?.[SERVER_KEY] !== undefined;
}

export function claudeCodeInstalled(): boolean {
  return Boolean(vscode.extensions.getExtension(CLAUDE_CODE_EXT_ID));
}

export interface ConfigState {
  userConfigured: boolean;
  skillInstalled: boolean;
}

export async function getConfigState(): Promise<ConfigState> {
  const [userConfigured, skillInstalled] = await Promise.all([
    isUserScopeConfigured(),
    skillIsInstalled()
  ]);
  return { userConfigured, skillInstalled };
}

function globalSkillDir(): string {
  return path.join(os.homedir(), '.claude', 'skills', SKILL_NAME);
}

async function skillIsInstalled(): Promise<boolean> {
  try {
    await fs.stat(path.join(globalSkillDir(), 'SKILL.md'));
    return true;
  } catch {
    return false;
  }
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
 * Offer to configure Claude Code. Single scope now (user): one stdio entry
 * works in every window because the bridge resolves its own workspace at
 * spawn time. The only remaining choice is whether to also install the skill.
 */
export async function offerInstall(
  context: vscode.ExtensionContext,
  opts: { force?: boolean } = {}
): Promise<void> {
  if (!opts.force) {
    if (!claudeCodeInstalled()) return;
    if (context.globalState.get<boolean>(PROMPTED_KEY)) return; // explicit "Don't ask again"
    if (await isUserScopeConfigured()) return;
  }

  const choices = ['Configure…', "Don't ask again", 'Not now'] as const;
  const message = opts.force
    ? 'Configure Claude Code to use Debug MCP?'
    : 'Claude Code is installed. Configure it to use this extension (registers the debug tools)?';

  const answer = await vscode.window.showInformationMessage(message, ...choices);
  if (answer === "Don't ask again") {
    await context.globalState.update(PROMPTED_KEY, true);
    return;
  }
  if (answer !== 'Configure…') return;

  const includeSkill = await vscode.window.showQuickPick(
    [
      { label: 'Yes (recommended)', description: 'Install the debug-mcp usage skill globally (~/.claude/skills/) so Claude drives these tools well.', value: true },
      { label: 'No', description: 'Only register the MCP server.', value: false }
    ],
    {
      title: 'Also install the debug-mcp usage skill?',
      placeHolder: 'The skill is a markdown file Claude auto-loads when relevant. Installed globally so it activates in any workspace.'
    }
  );
  if (!includeSkill) return; // dismissed

  const written: string[] = [];
  try {
    const result = await registerStdioBridge(bridgePathFor(context.extensionPath));
    written.push(result === 'created' ? 'Registered vscode-debug (stdio) at user scope' : 'Updated vscode-debug registration');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to configure Claude Code: ${msg}`);
    return;
  }

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

  await vscode.window.showInformationMessage(
    `${written.join('. ')}. Reload Claude Code to pick up changes.`
  );
}

/**
 * Remove user-scope MCP registration and/or the global skill. Best-effort.
 */
export async function uninstallClaudeCodeSupport(opts: {
  removeUserMcp: boolean;
  removeSkill: boolean;
}): Promise<string[]> {
  const removed: string[] = [];

  if (opts.removeUserMcp) {
    try {
      await execAsync(`claude mcp remove --scope user ${SERVER_KEY}`);
      removed.push('Unregistered vscode-debug at user scope');
    } catch (err: any) {
      const stderr = err?.stderr?.toString?.() ?? '';
      if (/not found|does not exist|no such/i.test(stderr) || /not found/i.test(err?.message ?? '')) {
        removed.push('vscode-debug was not registered at user scope');
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

  return removed;
}

/**
 * Best-effort cleanup on extension deactivation. Removes the global skill
 * only — leaves MCP registration alone since the user may have other tooling
 * pointing at the same config.
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
 * On activation/upgrade, if a debug-mcp skill is already installed, refresh it
 * from the bundled copy. Idempotent: writeSkill() compares bytes. No-op if the
 * user hasn't installed the skill.
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
