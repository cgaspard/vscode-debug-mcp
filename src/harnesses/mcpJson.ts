import * as fs from 'fs/promises';
import * as path from 'path';

import { SERVER_KEY, bridgeInvocation } from '../harness';

/**
 * Helpers for the portable `.mcp.json` format (the `mcpServers` map convention
 * read by Claude Code's project scope and many other MCP clients). Shared by the
 * generic installer; kept separate so the codex/opencode dialects don't leak in.
 */

export interface McpJsonEntry {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpJsonFile {
  mcpServers?: Record<string, McpJsonEntry>;
  [k: string]: unknown;
}

export function desiredMcpJsonEntry(bridgePath: string): McpJsonEntry {
  const inv = bridgeInvocation(bridgePath);
  return { type: 'stdio', command: inv.command, args: inv.args, env: inv.env };
}

export function entryMatches(entry: McpJsonEntry | undefined, bridgePath: string): boolean {
  if (!entry) return false;
  const desired = desiredMcpJsonEntry(bridgePath);
  return (
    entry.type === desired.type &&
    entry.command === desired.command &&
    Array.isArray(entry.args) &&
    entry.args[0] === desired.args?.[0] &&
    entry.env?.ELECTRON_RUN_AS_NODE === desired.env?.ELECTRON_RUN_AS_NODE
  );
}

export async function readMcpJson(file: string): Promise<{ raw: string; parsed: McpJsonFile } | undefined> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return { raw, parsed: JSON.parse(raw) as McpJsonFile };
  } catch (err: any) {
    if (err?.code === 'ENOENT') return undefined;
    throw err;
  }
}

/** Upsert our entry into a .mcp.json file, preserving other servers. */
export async function writeMcpJsonEntry(file: string, bridgePath: string): Promise<'created' | 'updated'> {
  const existing = await readMcpJson(file);
  const parsed: McpJsonFile = existing?.parsed ?? {};
  const had = parsed.mcpServers?.[SERVER_KEY] !== undefined;
  parsed.mcpServers = parsed.mcpServers ?? {};
  parsed.mcpServers[SERVER_KEY] = desiredMcpJsonEntry(bridgePath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  return had ? 'updated' : 'created';
}

/** Remove our entry from a .mcp.json file. Returns whether anything was removed. */
export async function removeMcpJsonEntry(file: string): Promise<boolean> {
  const existing = await readMcpJson(file);
  if (!existing || !existing.parsed.mcpServers?.[SERVER_KEY]) return false;
  delete existing.parsed.mcpServers[SERVER_KEY];
  await fs.writeFile(file, JSON.stringify(existing.parsed, null, 2) + '\n', 'utf8');
  return true;
}
