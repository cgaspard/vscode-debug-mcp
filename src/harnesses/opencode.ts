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

interface OpencodeLocalServer {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
  enabled?: boolean;
  [k: string]: unknown;
}

interface OpencodeConfig {
  $schema?: string;
  mcp?: Record<string, OpencodeLocalServer | Record<string, unknown>>;
  [k: string]: unknown;
}

const SCHEMA_URL = 'https://opencode.ai/config.json';

function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.trim().length
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), '.config');
  return path.join(xdg, 'opencode', 'opencode.json');
}

/** Project scope: opencode.json at the workspace root. */
function projectConfigPath(projectDir: string): string {
  return path.join(projectDir, 'opencode.json');
}

function configPathFor(scope: Scope, ctx: HarnessContext): string | undefined {
  if (scope === 'user') return userConfigPath();
  return ctx.projectDir ? projectConfigPath(ctx.projectDir) : undefined;
}

/** opencode merges command+args into a single array; env field is `environment`. */
function desiredServer(bridgePath: string): OpencodeLocalServer {
  const inv = bridgeInvocation(bridgePath);
  return { type: 'local', command: [inv.command, ...inv.args], environment: inv.env, enabled: true };
}

/** A thrown sentinel meaning the file is JSONC-with-comments we won't rewrite. */
class JsoncError extends Error {}

/**
 * True if `raw` contains JSON comments OUTSIDE of string values. A naive
 * `raw.includes('//')` would false-positive on URLs like the "$schema" value
 * "https://opencode.ai/..." that WE write — so we strip double-quoted strings
 * first, then look for `//` or `/*`. Only meaningful on text that already
 * failed JSON.parse (valid JSON cannot contain bare comments).
 */
function hasJsonComments(raw: string): boolean {
  const withoutStrings = raw.replace(/"(?:\\.|[^"\\])*"/g, '""');
  return /\/\/|\/\*/.test(withoutStrings);
}

/**
 * Read + parse the config. Returns undefined if absent. If the file fails to
 * parse BECAUSE it contains comments, throws JsoncError so callers can refuse
 * to rewrite it (which would strip the comments). A file that parses cleanly —
 * including one whose string values contain `//`, like our own $schema URL — is
 * always safe to rewrite.
 */
async function readConfig(file: string): Promise<{ raw: string; parsed: OpencodeConfig } | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err: any) {
    if (err?.code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return { raw, parsed: JSON.parse(raw) as OpencodeConfig };
  } catch (parseErr) {
    if (hasJsonComments(raw)) {
      throw new JsoncError(`${file} contains comments (JSONC) and cannot be edited automatically without dropping them.`);
    }
    throw parseErr;
  }
}

function serverMatches(server: unknown, bridgePath: string): boolean {
  if (!server || typeof server !== 'object') return false;
  const s = server as OpencodeLocalServer;
  const desired = desiredServer(bridgePath);
  return (
    s.type === 'local' &&
    Array.isArray(s.command) &&
    s.command.length === desired.command.length &&
    s.command.every((c, i) => c === desired.command[i]) &&
    s.environment?.ELECTRON_RUN_AS_NODE === desired.environment?.ELECTRON_RUN_AS_NODE
  );
}

async function scopeStatus(file: string, bridgePath: string): Promise<ScopeStatus> {
  let configured = false;
  let stale = false;
  try {
    const cfg = await readConfig(file);
    const server = cfg?.parsed.mcp?.[SERVER_KEY];
    configured = server !== undefined;
    if (configured) stale = !serverMatches(server, bridgePath);
  } catch {
    configured = false;
  }
  return { configured, stale, configPath: file };
}

export class OpencodeInstaller implements HarnessInstaller {
  readonly id = 'opencode' as const;
  readonly displayName = 'opencode';
  readonly blurb = 'opencode CLI. Adds a local MCP server to opencode.json (user: ~/.config/opencode/, project: repo root).';
  readonly scopes = ['user', 'project'] as const;

  async status(ctx: HarnessContext): Promise<HarnessStatus> {
    const detected = await commandOnPath('opencode');
    const bridgePath = bridgePathFor(ctx.extensionPath);
    const user = await scopeStatus(userConfigPath(), bridgePath);
    const project = ctx.projectDir
      ? await scopeStatus(projectConfigPath(ctx.projectDir), bridgePath)
      : undefined;
    if (!detected) user.detail = '`opencode` not found on PATH';
    return { detected, user, project };
  }

  async install(ctx: HarnessContext, scope: Scope): Promise<InstallResult> {
    const file = configPathFor(scope, ctx);
    if (!file) return { ok: false, error: 'No workspace folder is open.' };

    let parsed: OpencodeConfig = {};
    try {
      const existing = await readConfig(file);
      if (existing) parsed = existing.parsed;
    } catch (err) {
      if (err instanceof JsoncError) {
        return {
          ok: false,
          error: `${err.message} Add this under "mcp" manually:\n${JSON.stringify({ [SERVER_KEY]: desiredServer(bridgePathFor(ctx.extensionPath)) }, null, 2)}`
        };
      }
      return { ok: false, error: `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }

    const existed = parsed.mcp?.[SERVER_KEY] !== undefined;
    parsed.mcp = parsed.mcp ?? {};
    parsed.mcp[SERVER_KEY] = desiredServer(bridgePathFor(ctx.extensionPath));
    if (!parsed.$schema) parsed.$schema = SCHEMA_URL;

    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    } catch (err) {
      return { ok: false, error: `Could not write ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
    const where = scope === 'project' ? 'project opencode.json' : 'opencode config';
    return { ok: true, messages: [existed ? `Updated vscode-debug in ${where}` : `Added vscode-debug to ${where}`] };
  }

  async uninstall(ctx: HarnessContext, scope: Scope): Promise<InstallResult> {
    const file = configPathFor(scope, ctx);
    if (!file) return { ok: false, error: 'No workspace folder is open.' };
    let cfg;
    try {
      cfg = await readConfig(file);
    } catch (err) {
      if (err instanceof JsoncError) {
        return { ok: false, error: `${err.message} Remove the "${SERVER_KEY}" entry under "mcp" manually.` };
      }
      return { ok: false, error: `Could not read ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!cfg || !cfg.parsed.mcp?.[SERVER_KEY]) {
      return { ok: true, messages: ['vscode-debug was not in this opencode config'] };
    }
    delete cfg.parsed.mcp[SERVER_KEY];
    try {
      await fs.writeFile(file, JSON.stringify(cfg.parsed, null, 2) + '\n', 'utf8');
    } catch (err) {
      return { ok: false, error: `Could not write ${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, messages: ['Removed vscode-debug from opencode config'] };
  }
}
