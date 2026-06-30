import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

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
import { commandOnPath } from './detect';
import { readBlock, upsertBlock, removeBlock, type CodexStdioEntry } from '../tomlEdit';

function codexHome(): string {
  const env = process.env.CODEX_HOME;
  return env && env.trim().length ? env : path.join(os.homedir(), '.codex');
}

function userConfigPath(): string {
  return path.join(codexHome(), 'config.toml');
}

/** Project scope: .codex/config.toml inside the repo (trusted projects only). */
function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, '.codex', 'config.toml');
}

function configPathFor(scope: Scope, ctx: HarnessContext): string | undefined {
  if (scope === 'user') return userConfigPath();
  return ctx.projectDir ? projectConfigPath(ctx.projectDir) : undefined;
}

function desiredEntry(bridgePath: string): CodexStdioEntry {
  const inv = bridgeInvocation(bridgePath);
  return { command: inv.command, args: inv.args, env: inv.env };
}

function entryMatches(entry: CodexStdioEntry, bridgePath: string): boolean {
  const desired = desiredEntry(bridgePath);
  return (
    entry.command === desired.command &&
    entry.args.length === desired.args.length &&
    entry.args.every((a, i) => a === desired.args[i]) &&
    entry.env.ELECTRON_RUN_AS_NODE === desired.env.ELECTRON_RUN_AS_NODE
  );
}

async function readConfigText(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return undefined;
    throw err;
  }
}

async function scopeStatus(file: string, bridgePath: string): Promise<ScopeStatus> {
  let configured = false;
  let stale = false;
  try {
    const text = await readConfigText(file);
    if (text !== undefined) {
      const entry = readBlock(text, SERVER_KEY);
      configured = entry !== undefined;
      if (entry) stale = !entryMatches(entry, bridgePath);
    }
  } catch {
    configured = false;
  }
  return { configured, stale, configPath: file };
}

export class CodexInstaller implements HarnessInstaller {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex';
  readonly blurb = 'OpenAI Codex CLI. Adds an [mcp_servers.vscode-debug] table to config.toml (user: ~/.codex/, project: ./.codex/).';
  readonly scopes = ['user', 'project'] as const;

  async status(ctx: HarnessContext): Promise<HarnessStatus> {
    const detected = await commandOnPath('codex');
    const bridgePath = bridgePathFor(ctx.extensionPath);
    const user = await scopeStatus(userConfigPath(), bridgePath);
    const project = ctx.projectDir
      ? await scopeStatus(projectConfigPath(ctx.projectDir), bridgePath)
      : undefined;
    if (!detected) user.detail = '`codex` not found on PATH';
    if (project) project.detail = 'Project config only loads for codex-trusted directories';
    return { detected, user, project };
  }

  async install(ctx: HarnessContext, scope: Scope): Promise<InstallResult> {
    const file = configPathFor(scope, ctx);
    if (!file) return { ok: false, error: 'No workspace folder is open.' };

    let text: string;
    try {
      text = (await readConfigText(file)) ?? '';
    } catch (err) {
      return { ok: false, error: `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const existed = readBlock(text, SERVER_KEY) !== undefined;
    const next = upsertBlock(text, SERVER_KEY, desiredEntry(bridgePathFor(ctx.extensionPath)));
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, next, 'utf8');
    } catch (err) {
      return { ok: false, error: `Could not write ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const messages = [existed ? 'Updated [mcp_servers.vscode-debug] in codex config' : 'Added [mcp_servers.vscode-debug] to codex config'];
    if (scope === 'project') {
      messages.push('⚠ Codex only loads project config for TRUSTED directories — run codex here and trust this folder for it to take effect.');
    }
    return { ok: true, messages };
  }

  async uninstall(ctx: HarnessContext, scope: Scope): Promise<InstallResult> {
    const file = configPathFor(scope, ctx);
    if (!file) return { ok: false, error: 'No workspace folder is open.' };
    let text;
    try {
      text = await readConfigText(file);
    } catch (err) {
      return { ok: false, error: `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (text === undefined) {
      return { ok: true, messages: ['vscode-debug was not in this codex config'] };
    }
    const { content, removed } = removeBlock(text, SERVER_KEY);
    if (!removed) {
      return { ok: true, messages: ['vscode-debug was not in this codex config'] };
    }
    try {
      await fs.writeFile(file, content, 'utf8');
    } catch (err) {
      return { ok: false, error: `Could not write ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, messages: ['Removed [mcp_servers.vscode-debug] from codex config'] };
  }
}
