import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const CLAUDE_CODE_EXT_ID = 'anthropic.claude-code';
const SERVER_KEY = 'vscode-debug';
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

export function claudeCodeInstalled(): boolean {
  return Boolean(vscode.extensions.getExtension(CLAUDE_CODE_EXT_ID));
}

export interface InstallTarget {
  label: string;
  description: string;
  file: string;
}

function targets(): InstallTarget[] {
  const out: InstallTarget[] = [];
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    out.push({
      label: 'This workspace',
      description: 'Write .mcp.json in the project root (shared with collaborators via git).',
      file: path.join(folder.uri.fsPath, '.mcp.json')
    });
  }
  out.push({
    label: 'User settings (all projects)',
    description: 'Register globally in ~/.claude/settings.json — available in every workspace you open.',
    file: path.join(os.homedir(), '.claude', 'settings.json')
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
    detail: t.file,
    target: t
  }));
  const pick = await vscode.window.showQuickPick(items, {
    title: 'Where should the MCP server be registered?',
    placeHolder: 'Pick a scope'
  });
  if (!pick) return;

  try {
    const result = await writeMergedMcpJson(pick.target.file, serverUrl);
    await context.globalState.update(PROMPTED_KEY, true);
    const verb = result === 'created' ? 'Created' : result === 'updated' ? 'Updated' : 'Already configured in';
    const action = await vscode.window.showInformationMessage(
      `${verb} ${pick.target.file}. Reload Claude Code to pick up the change.`,
      'Open file'
    );
    if (action === 'Open file') {
      const doc = await vscode.workspace.openTextDocument(pick.target.file);
      await vscode.window.showTextDocument(doc);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`Failed to write ${pick.target.file}: ${msg}`);
  }
}

export async function resetInstallPromptFlag(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(PROMPTED_KEY, false);
}
