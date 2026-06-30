import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

import { SERVER_KEY } from './harness';

const SKILL_NAME = 'debug-mcp';

/**
 * The bundled skill source shipped in the .vsix. Claude Code is the only harness
 * with a skill system (opencode/codex have none), so skill logic lives here
 * rather than in the harness abstraction.
 */
export function bundledSkillSource(extensionPath: string): string {
  return path.join(extensionPath, 'resources', 'skill', 'SKILL.md');
}

export function globalSkillDir(): string {
  return path.join(os.homedir(), '.claude', 'skills', SKILL_NAME);
}

export async function skillIsInstalled(): Promise<boolean> {
  try {
    await fs.stat(path.join(globalSkillDir(), 'SKILL.md'));
    return true;
  } catch {
    return false;
  }
}

export async function writeSkill(skillDir: string, sourceFile: string): Promise<'created' | 'updated'> {
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

export async function removeSkill(): Promise<void> {
  await fs.rm(globalSkillDir(), { recursive: true, force: true });
}

/**
 * Best-effort cleanup on extension deactivation. Removes the global skill
 * only — leaves MCP registration alone since the user may have other tooling
 * pointing at the same config.
 */
export async function deactivateCleanup(): Promise<void> {
  try {
    await removeSkill();
  } catch {
    /* ignore — best-effort */
  }
}

/**
 * On activation/upgrade, if a debug-mcp skill is already installed, refresh it
 * from the bundled copy. Idempotent: compares bytes. No-op if not installed.
 */
export async function refreshSkillIfInstalled(extensionPath: string): Promise<'updated' | 'unchanged' | 'not-installed'> {
  const targetFile = path.join(globalSkillDir(), 'SKILL.md');
  try {
    await fs.stat(targetFile);
  } catch {
    return 'not-installed';
  }
  try {
    const desired = await fs.readFile(bundledSkillSource(extensionPath), 'utf8');
    const current = await fs.readFile(targetFile, 'utf8');
    if (current === desired) return 'unchanged';
    await fs.writeFile(targetFile, desired, 'utf8');
    return 'updated';
  } catch {
    return 'not-installed';
  }
}

// ---------------------------------------------------------------------------
// First-run prompt state. Now per-harness so opencode/codex get their own
// one-time offer independent of Claude's.
// ---------------------------------------------------------------------------

const PROMPTED_PREFIX = 'debugMcp.installPromptDeclined';

function promptKey(harnessId: string): string {
  return `${PROMPTED_PREFIX}.${harnessId}`;
}

export function installPromptDeclined(context: vscode.ExtensionContext, harnessId: string): boolean {
  return Boolean(context.globalState.get<boolean>(promptKey(harnessId)));
}

export async function declineInstallPrompt(context: vscode.ExtensionContext, harnessId: string): Promise<void> {
  await context.globalState.update(promptKey(harnessId), true);
}

/** Clear all per-harness "don't ask again" flags so first-run offers show again. */
export async function resetInstallPromptFlags(
  context: vscode.ExtensionContext,
  harnessIds: string[]
): Promise<void> {
  await Promise.all(harnessIds.map((id) => context.globalState.update(promptKey(id), false)));
}

// Re-exported for convenience so call sites can keep a single import surface.
export { SERVER_KEY };
