/**
 * Standalone unit tests for the file-based installers (opencode, codex, generic)
 * — no VS Code host, no test framework. Drives the REAL installer classes
 * against a throwaway temp dir by pointing HOME / XDG_CONFIG_HOME / CODEX_HOME
 * at it, then asserts the config files we write/read/remove round-trip.
 *
 * Claude Code is intentionally NOT covered here: it shells out to the `claude`
 * CLI and imports `vscode`, so it belongs in the e2e suite, not a pure unit run.
 *
 * Run: `npm run test:unit` (compiles to out-test/ then executes with node).
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import type { HarnessContext } from '../harness';
import { OpencodeInstaller } from './opencode';
import { CodexInstaller } from './codex';
import { GenericMcpInstaller } from './generic';

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ✓ ${name}`);
}

/** Fresh sandbox: a temp HOME + temp project dir, env pointed at them. */
function sandbox(): { home: string; project: string; ctx: HarnessContext; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vdmcp-test-'));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });

  const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, CODEX: process.env.CODEX_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.CODEX_HOME = path.join(home, '.codex');

  return {
    home,
    project,
    ctx: { extensionPath: path.join(root, 'ext'), projectDir: project },
    cleanup: () => {
      process.env.HOME = saved.HOME;
      process.env.XDG_CONFIG_HOME = saved.XDG;
      process.env.CODEX_HOME = saved.CODEX;
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function read(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

async function run() {
  // ---- opencode ----
  await check('opencode: user install writes mcp.<key> with array command + environment', async () => {
    const sb = sandbox();
    try {
      const inst = new OpencodeInstaller();
      const res = await inst.install(sb.ctx, 'user');
      assert.ok(res.ok, JSON.stringify(res));
      const file = path.join(sb.home, '.config', 'opencode', 'opencode.json');
      const cfg = JSON.parse(read(file));
      const server = cfg.mcp['vscode-debug'];
      assert.strictEqual(server.type, 'local');
      assert.ok(Array.isArray(server.command), 'command is an array');
      assert.strictEqual(server.environment.ELECTRON_RUN_AS_NODE, '1');
      assert.strictEqual(server.enabled, true);
      // status reflects it
      const st = await inst.status(sb.ctx);
      assert.strictEqual(st.user.configured, true);
      assert.strictEqual(st.user.stale, false);
    } finally { sb.cleanup(); }
  });

  await check('opencode: install preserves unrelated keys and other servers', async () => {
    const sb = sandbox();
    try {
      const file = path.join(sb.home, '.config', 'opencode', 'opencode.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ theme: 'dark', mcp: { other: { type: 'local', command: ['x'] } } }, null, 2));
      const inst = new OpencodeInstaller();
      assert.ok((await inst.install(sb.ctx, 'user')).ok);
      const cfg = JSON.parse(read(file));
      assert.strictEqual(cfg.theme, 'dark', 'kept unrelated key');
      assert.ok(cfg.mcp.other, 'kept other server');
      assert.ok(cfg.mcp['vscode-debug'], 'added ours');
    } finally { sb.cleanup(); }
  });

  await check('opencode: project install writes ./opencode.json; uninstall removes it', async () => {
    const sb = sandbox();
    try {
      const inst = new OpencodeInstaller();
      assert.ok((await inst.install(sb.ctx, 'project')).ok);
      const file = path.join(sb.project, 'opencode.json');
      assert.ok(fs.existsSync(file), 'project file written');
      assert.ok(JSON.parse(read(file)).mcp['vscode-debug']);

      const un = await inst.uninstall(sb.ctx, 'project');
      assert.ok(un.ok);
      assert.strictEqual(JSON.parse(read(file)).mcp['vscode-debug'], undefined, 'entry removed');
      const st = await inst.status(sb.ctx);
      assert.strictEqual(st.project?.configured, false);
    } finally { sb.cleanup(); }
  });

  await check('opencode: refuses to rewrite a JSONC file with comments', async () => {
    const sb = sandbox();
    try {
      const file = path.join(sb.home, '.config', 'opencode', 'opencode.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{\n  // a comment\n  "mcp": {}\n}');
      const inst = new OpencodeInstaller();
      const res = await inst.install(sb.ctx, 'user');
      assert.strictEqual(res.ok, false, 'install refused');
      // original file untouched
      assert.ok(read(file).includes('// a comment'));
    } finally { sb.cleanup(); }
  });

  // ---- codex ----
  await check('codex: user install writes [mcp_servers.vscode-debug] TOML; status sees it', async () => {
    const sb = sandbox();
    try {
      const inst = new CodexInstaller();
      assert.ok((await inst.install(sb.ctx, 'user')).ok);
      const file = path.join(sb.home, '.codex', 'config.toml');
      const text = read(file);
      assert.ok(text.includes('[mcp_servers.vscode-debug]'));
      assert.ok(/command = ".*"/.test(text));
      assert.ok(text.includes('ELECTRON_RUN_AS_NODE = "1"'));
      const st = await inst.status(sb.ctx);
      assert.strictEqual(st.user.configured, true);
      assert.strictEqual(st.user.stale, false);
    } finally { sb.cleanup(); }
  });

  await check('codex: install preserves other tables; uninstall leaves them', async () => {
    const sb = sandbox();
    try {
      const file = path.join(sb.home, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "x"\nargs = []\n');
      const inst = new CodexInstaller();
      assert.ok((await inst.install(sb.ctx, 'user')).ok);
      let text = read(file);
      assert.ok(text.includes('model = "gpt-5"'), 'kept top-level');
      assert.ok(text.includes('[mcp_servers.other]'), 'kept other server');

      assert.ok((await inst.uninstall(sb.ctx, 'user')).ok);
      text = read(file);
      assert.ok(!text.includes('[mcp_servers.vscode-debug]'), 'ours gone');
      assert.ok(text.includes('[mcp_servers.other]'), 'other still there');
      assert.ok(text.includes('model = "gpt-5"'), 'top-level still there');
    } finally { sb.cleanup(); }
  });

  await check('codex: project install warns about trust requirement', async () => {
    const sb = sandbox();
    try {
      const inst = new CodexInstaller();
      const res = await inst.install(sb.ctx, 'project');
      assert.ok(res.ok);
      assert.ok(res.ok && res.messages.some((m) => /trust/i.test(m)), 'trust warning present');
      assert.ok(fs.existsSync(path.join(sb.project, '.codex', 'config.toml')));
    } finally { sb.cleanup(); }
  });

  // ---- generic .mcp.json ----
  await check('generic: project-only install writes root .mcp.json (mcpServers shape)', async () => {
    const sb = sandbox();
    try {
      const inst = new GenericMcpInstaller();
      assert.deepStrictEqual(inst.scopes, ['project']);
      // user scope is rejected
      const userRes = await inst.install(sb.ctx, 'user');
      assert.strictEqual(userRes.ok, false, 'user scope rejected');

      assert.ok((await inst.install(sb.ctx, 'project')).ok);
      const file = path.join(sb.project, '.mcp.json');
      const cfg = JSON.parse(read(file));
      assert.strictEqual(cfg.mcpServers['vscode-debug'].type, 'stdio');
      assert.ok(Array.isArray(cfg.mcpServers['vscode-debug'].args));

      const st = await inst.status(sb.ctx);
      assert.strictEqual(st.project?.configured, true);

      assert.ok((await inst.uninstall(sb.ctx, 'project')).ok);
      assert.strictEqual(JSON.parse(read(file)).mcpServers['vscode-debug'], undefined);
    } finally { sb.cleanup(); }
  });

  await check('generic: missing projectDir yields an error result, not a throw', async () => {
    const sb = sandbox();
    try {
      const inst = new GenericMcpInstaller();
      const res = await inst.install({ extensionPath: sb.ctx.extensionPath }, 'project');
      assert.strictEqual(res.ok, false);
    } finally { sb.cleanup(); }
  });

  // ---- staleness detection ----
  await check('staleness: a hand-broken entry is reported stale', async () => {
    const sb = sandbox();
    try {
      const file = path.join(sb.home, '.config', 'opencode', 'opencode.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // configured but with the wrong command + missing env flag → stale
      fs.writeFileSync(file, JSON.stringify({ mcp: { 'vscode-debug': { type: 'local', command: ['old'], environment: {} } } }, null, 2));
      const st = await new OpencodeInstaller().status(sb.ctx);
      assert.strictEqual(st.user.configured, true);
      assert.strictEqual(st.user.stale, true, 'detected as stale');
    } finally { sb.cleanup(); }
  });

  // eslint-disable-next-line no-console
  console.log(`\ninstallers: ${passed} checks passed`);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
