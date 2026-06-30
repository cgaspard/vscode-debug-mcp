/**
 * Standalone assertion tests for tomlEdit.ts — no test framework. Run after a
 * tsc build, or directly with ts via the npm script. Exits non-zero on failure.
 */
import * as assert from 'assert';
import { serializeBlock, readBlock, upsertBlock, removeBlock, type CodexStdioEntry } from './tomlEdit';

const KEY = 'vscode-debug';
const ENTRY: CodexStdioEntry = {
  command: '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  args: ['/Users/me/.vscode/extensions/cgaspard.vscode-debug-mcp-0.4.0/out/bridge.js'],
  env: { ELECTRON_RUN_AS_NODE: '1' }
};

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  // eslint-disable-next-line no-console
  console.log(`  ✓ ${name}`);
}

// 1. Round-trip on an empty file.
check('upsert into empty file then read back', () => {
  const out = upsertBlock('', KEY, ENTRY);
  assert.ok(out.includes('[mcp_servers.vscode-debug]'));
  const back = readBlock(out, KEY);
  assert.deepStrictEqual(back, ENTRY);
});

// 2. Preserve surrounding content on upsert (append case).
check('append preserves existing config', () => {
  const existing = `model = "gpt-5"\napproval_policy = "on-request"\n\n[mcp_servers.docs]\ncommand = "docs-server"\nargs = []\n`;
  const out = upsertBlock(existing, KEY, ENTRY);
  assert.ok(out.includes('model = "gpt-5"'), 'kept top-level key');
  assert.ok(out.includes('[mcp_servers.docs]'), 'kept the other server');
  assert.ok(out.includes('command = "docs-server"'), 'kept the other server body');
  const back = readBlock(out, KEY);
  assert.deepStrictEqual(back, ENTRY);
  // The other server is still readable as its own (sanity: our find is scoped).
  assert.strictEqual(readBlock(out, 'docs')?.command, 'docs-server');
});

// 3. Replace in place — idempotent upsert, no duplicate tables.
check('re-upsert replaces in place (no duplicate table)', () => {
  const once = upsertBlock('top = 1\n', KEY, ENTRY);
  const changed: CodexStdioEntry = { ...ENTRY, args: ['/new/path/out/bridge.js'] };
  const twice = upsertBlock(once, KEY, changed);
  const headers = twice.split('\n').filter((l) => l.trim() === '[mcp_servers.vscode-debug]');
  assert.strictEqual(headers.length, 1, 'exactly one header after re-upsert');
  assert.ok(twice.includes('top = 1'), 'kept unrelated content');
  assert.deepStrictEqual(readBlock(twice, KEY), changed);
});

// 4. Replace a mid-file block surrounded by other tables.
check('replace mid-file block keeps neighbors', () => {
  const existing =
    `[mcp_servers.alpha]\ncommand = "a"\nargs = []\n\n` +
    `[mcp_servers.vscode-debug]\ncommand = "old"\nargs = ["old.js"]\n\n` +
    `[mcp_servers.beta]\ncommand = "b"\nargs = []\n`;
  const out = upsertBlock(existing, KEY, ENTRY);
  assert.strictEqual(readBlock(out, 'alpha')?.command, 'a');
  assert.strictEqual(readBlock(out, 'beta')?.command, 'b');
  assert.deepStrictEqual(readBlock(out, KEY), ENTRY);
  assert.ok(!out.includes('"old"'), 'old value gone');
});

// 5. Remove a block and confirm neighbors + formatting survive.
check('remove block, neighbors intact', () => {
  const existing =
    `model = "x"\n\n[mcp_servers.vscode-debug]\ncommand = "c"\nargs = []\n\n[mcp_servers.beta]\ncommand = "b"\nargs = []\n`;
  const { content, removed } = removeBlock(existing, KEY);
  assert.strictEqual(removed, true);
  assert.strictEqual(readBlock(content, KEY), undefined);
  assert.ok(content.includes('model = "x"'));
  assert.strictEqual(readBlock(content, 'beta')?.command, 'b');
  // No leading/trailing blank pileup, single trailing newline.
  assert.ok(content.endsWith('\n') && !content.endsWith('\n\n'));
});

// 6. Remove when absent is a no-op.
check('remove when absent is a no-op', () => {
  const existing = `model = "x"\n`;
  const { content, removed } = removeBlock(existing, KEY);
  assert.strictEqual(removed, false);
  assert.strictEqual(content, existing);
});

// 7. Comments and a trailing comment on a header are tolerated.
check('comments around block are preserved and not confused', () => {
  const existing =
    `# my codex config\nmodel = "x"  # inline comment\n\n[mcp_servers.vscode-debug]\ncommand = "c"\nargs = []\n`;
  const out = upsertBlock(existing, KEY, ENTRY);
  assert.ok(out.includes('# my codex config'));
  assert.ok(out.includes('# inline comment'));
  assert.deepStrictEqual(readBlock(out, KEY), ENTRY);
});

// 8. String escaping round-trips (Windows-style path with backslashes, quotes).
check('escaping round-trips', () => {
  const weird: CodexStdioEntry = {
    command: 'C:\\Program Files\\Microsoft VS Code\\Code.exe',
    args: ['C:\\ext\\bridge.js', 'a"b'],
    env: { ELECTRON_RUN_AS_NODE: '1', QUOTED: 'he said "hi"' }
  };
  const out = upsertBlock('', KEY, weird);
  assert.deepStrictEqual(readBlock(out, KEY), weird);
});

// 9. Empty env omits the env line entirely (codex omits empty tables).
check('empty env omits env line', () => {
  const noEnv: CodexStdioEntry = { command: 'node', args: ['b.js'], env: {} };
  const block = serializeBlock(KEY, noEnv);
  assert.ok(!/\benv\b/.test(block), 'no env line emitted');
  assert.deepStrictEqual(readBlock(block, KEY), noEnv);
});

// eslint-disable-next-line no-console
console.log(`\ntomlEdit: ${passed} checks passed`);
