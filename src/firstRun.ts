import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const CLAUDE_CODE_EXT_ID = 'anthropic.claude-code';
const SERVER_KEY = 'vscode-debug';
const SKILL_NAME = 'debug-mcp';
const PROMPTED_KEY = 'debugMcp.installPrompted';

interface McpJson {
  mcpServers?: Record<string, unknown>;
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

export function claudeCodeInstalled(): boolean {
  return Boolean(vscode.extensions.getExtension(CLAUDE_CODE_EXT_ID));
}

export interface ConfigState {
  workspaceConfigured: boolean;
  userConfigured: boolean;
}

async function fileMentionsServer(file: string): Promise<boolean> {
  const json = await readJsonIfExists(file);
  if (!json) return false;
  const servers = (json.mcpServers ?? {}) as Record<string, unknown>;
  return Boolean(servers[SERVER_KEY]);
}

export async function getConfigState(): Promise<ConfigState> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const userFile = path.join(os.homedir(), '.claude', 'settings.json');
  const [workspaceConfigured, userConfigured] = await Promise.all([
    folder ? fileMentionsServer(path.join(folder.uri.fsPath, '.mcp.json')) : Promise.resolve(false),
    fileMentionsServer(userFile)
  ]);
  return { workspaceConfigured, userConfigured };
}

interface InstallTarget {
  label: string;
  description: string;
  mcpFile: string;
  skillDir: string;
  scope: 'workspace' | 'user';
}

function targets(): InstallTarget[] {
  const out: InstallTarget[] = [];
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    const root = folder.uri.fsPath;
    out.push({
      label: 'This workspace',
      description: 'Write .mcp.json + skill into the project (shared with collaborators via git).',
      mcpFile: path.join(root, '.mcp.json'),
      skillDir: path.join(root, '.claude', 'skills', SKILL_NAME),
      scope: 'workspace'
    });
  }
  out.push({
    label: 'User settings (all projects)',
    description: 'Register globally in ~/.claude/ — available in every workspace you open.',
    mcpFile: path.join(os.homedir(), '.claude', 'settings.json'),
    skillDir: path.join(os.homedir(), '.claude', 'skills', SKILL_NAME),
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
    if (context.globalState.get<boolean>(PROMPTED_KEY)) return;
    if (!claudeCodeInstalled()) return;
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
    detail: `MCP: ${t.mcpFile}\nSkill: ${t.skillDir}/SKILL.md`,
    target: t
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Where should Debug MCP be registered?',
    placeHolder: 'Pick a scope (applies to both MCP config and skill)'
  });
  if (!pick) return;

  const includeSkill = await vscode.window.showQuickPick(
    [
      { label: 'Yes (recommended)', description: 'Install the usage skill so Claude knows how to drive these tools well.', value: true },
      { label: 'No', description: 'Only register the MCP server.', value: false }
    ],
    {
      title: 'Also install the debug-mcp usage skill?',
      placeHolder: 'The skill is a markdown file Claude auto-loads when relevant.'
    }
  );
  if (!includeSkill) return; // user dismissed

  const written: string[] = [];

  try {
    const mcpResult = await writeMergedMcpJson(pick.target.mcpFile, serverUrl);
    written.push(`${mcpResult === 'created' ? 'Created' : mcpResult === 'updated' ? 'Updated' : 'Verified'} ${pick.target.mcpFile}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to write ${pick.target.mcpFile}: ${msg}`);
    return;
  }

  if (includeSkill.value) {
    const sourceSkill = path.join(context.extensionPath, 'resources', 'skill', 'SKILL.md');
    try {
      const skillResult = await writeSkill(pick.target.skillDir, sourceSkill);
      written.push(`${skillResult === 'created' ? 'Installed' : 'Updated'} skill at ${pick.target.skillDir}/SKILL.md`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`MCP config written, but skill install failed: ${msg}`);
    }
  }

  await context.globalState.update(PROMPTED_KEY, true);

  const action = await vscode.window.showInformationMessage(
    `${written.join('. ')}. Reload Claude Code to pick up changes.`,
    'Open MCP file'
  );
  if (action === 'Open MCP file') {
    const doc = await vscode.workspace.openTextDocument(pick.target.mcpFile);
    await vscode.window.showTextDocument(doc);
  }
}

export async function resetInstallPromptFlag(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(PROMPTED_KEY, false);
}
