import * as path from 'path';

/**
 * The MCP server key / table name used in every harness's config. Becomes the
 * tool-name prefix the model sees (e.g. `mcp__vscode-debug__*` in Claude/codex,
 * `vscode-debug_*` in opencode), so it must stay stable across versions.
 */
export const SERVER_KEY = 'vscode-debug';

/** The launcher triple every harness ultimately needs, regardless of dialect. */
export interface BridgeInvocation {
  /** Absolute command — VS Code's Electron binary (process.execPath). */
  command: string;
  /** argv after the command — the bridge script path. */
  args: string[];
  /** Env that must be set so Electron runs the .js as Node, not an editor file. */
  env: Record<string, string>;
}

export function bridgePathFor(extensionPath: string): string {
  return path.join(extensionPath, 'out', 'bridge.js');
}

/**
 * The desired stdio invocation: spawn the bridge with the Node that runs VS
 * Code's extension host. The bridge resolves its own per-window socket at
 * runtime, so a single user-scope entry works in every workspace.
 *
 * process.execPath here is VS Code's Electron binary (e.g. "Code Helper"), NOT
 * a plain `node`. Given a `.js` path as argv, Electron treats it as a FILE TO
 * OPEN in a window unless ELECTRON_RUN_AS_NODE=1 forces Node-interpreter mode.
 * Without this env, a harness spawning the server pops bridge.js into the
 * editor instead of running it. The flag is mandatory, not optional. This is
 * the single source of truth shared by every harness installer and by the
 * native VS Code MCP provider (mcpProvider.ts).
 */
export function bridgeInvocation(bridgePath: string): BridgeInvocation {
  return {
    command: process.execPath,
    args: [bridgePath],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  };
}

export type HarnessId = 'claude-code' | 'opencode' | 'codex' | 'generic';

/** Where a registration lives: the user's global config, or one repo's config. */
export type Scope = 'user' | 'project';

/** Per-scope state of our registration. */
export interface ScopeStatus {
  /** Our server is registered in this scope's config. */
  configured: boolean;
  /**
   * Configured, but the registered entry no longer matches the desired bridge
   * invocation (e.g. an old extension version's path, or a missing env flag).
   * Implies `configured`. Drives the activation self-heal (user scope only).
   */
  stale: boolean;
  /** Human-readable path to the config file we manage for this scope. */
  configPath: string;
  /** Optional extra line for the manager UI (e.g. "skill installed"). */
  detail?: string;
}

/** What a harness installer reports about its current state on this machine. */
export interface HarnessStatus {
  /** The harness tooling is present (extension installed, or CLI on PATH). */
  detected: boolean;
  /** User/global scope state. */
  user: ScopeStatus;
  /**
   * Project scope state for the current workspace, or undefined when there is
   * no workspace folder open (project install is then unavailable).
   */
  project?: ScopeStatus;
}

/** Options threaded through every installer call. */
export interface HarnessContext {
  extensionPath: string;
  /** Absolute path to the workspace folder, or undefined if none is open. */
  projectDir?: string;
}

export type InstallResult = { ok: true; messages: string[] } | { ok: false; error: string };

/**
 * One installer per supported harness. The reusable core (the bridge
 * invocation, the per-window socket model) lives here in harness.ts; each
 * implementation owns only its config dialect — where the file lives, JSON vs
 * TOML, the key/table name, and the env field name.
 */
export interface HarnessInstaller {
  readonly id: HarnessId;
  /** Display name for menus and the manager panel, e.g. "Claude Code". */
  readonly displayName: string;
  /** One-line description of where/how this harness is configured. */
  readonly blurb: string;
  /**
   * Scopes this harness supports. Most support both; the generic .mcp.json
   * target is project-only (a global .mcp.json has no well-defined home).
   */
  readonly scopes: readonly Scope[];

  status(ctx: HarnessContext): Promise<HarnessStatus>;

  /**
   * Register (or re-register) our server at the given scope. Idempotent:
   * replaces any prior entry under SERVER_KEY in place. Project scope requires
   * ctx.projectDir; returns an error result if it's missing.
   */
  install(ctx: HarnessContext, scope: Scope): Promise<InstallResult>;

  /** Remove our server at the given scope. Best-effort. */
  uninstall(ctx: HarnessContext, scope: Scope): Promise<InstallResult>;
}

// ---------------------------------------------------------------------------
// Registry. Concrete installers are imported lazily inside the factory so this
// module stays free of `vscode`/`fs` imports for the pure helpers above (the
// TOML tests import bridgeInvocation without pulling in the extension host).
// ---------------------------------------------------------------------------

let cached: HarnessInstaller[] | undefined;

export function allInstallers(): HarnessInstaller[] {
  if (cached) return cached;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ClaudeCodeInstaller } = require('./harnesses/claudeCode');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { OpencodeInstaller } = require('./harnesses/opencode');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { CodexInstaller } = require('./harnesses/codex');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GenericMcpInstaller } = require('./harnesses/generic');
  cached = [
    new ClaudeCodeInstaller(),
    new OpencodeInstaller(),
    new CodexInstaller(),
    new GenericMcpInstaller()
  ];
  return cached;
}

export function installerById(id: HarnessId): HarnessInstaller | undefined {
  return allInstallers().find((i) => i.id === id);
}

export interface HarnessStatusReport {
  installer: HarnessInstaller;
  status: HarnessStatus;
}

export async function reportAll(ctx: HarnessContext): Promise<HarnessStatusReport[]> {
  const installers = allInstallers();
  const statuses = await Promise.all(installers.map((i) => i.status(ctx)));
  return installers.map((installer, idx) => ({ installer, status: statuses[idx] }));
}

/**
 * Re-point any harness whose USER-scope registered entry is stale (e.g. after a
 * version bump that changed the bridge path). Only touches harnesses already
 * configured at user scope — never auto-installs into one the user hasn't opted
 * into, and never touches project files (those live in the user's repos).
 * Returns the display names that were re-pointed.
 */
export async function selfHealStale(extensionPath: string): Promise<string[]> {
  const ctx: HarnessContext = { extensionPath };
  const reports = await reportAll(ctx);
  const healed: string[] = [];
  for (const { installer, status } of reports) {
    if (status.user.configured && status.user.stale) {
      const result = await installer.install(ctx, 'user');
      if (result.ok) healed.push(installer.displayName);
    }
  }
  return healed;
}
