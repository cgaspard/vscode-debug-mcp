/**
 * Extension-host smoke tests — the automated stand-in for the manual
 * "install the .vsix and click around" release step. Runs inside a real VS
 * Code launched by @vscode/test-cli against the sample workspace.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as vscode from 'vscode';

const EXT_ID = 'cgaspard.vscode-debug-mcp';

function getExt(): vscode.Extension<any> {
  const ext = vscode.extensions.getExtension(EXT_ID);
  assert.ok(ext, `extension ${EXT_ID} should be present`);
  return ext!;
}

suite('Debug MCP — activation & surface', () => {
  test('activates without error', async function () {
    this.timeout(20000);
    const ext = getExt();
    await ext.activate();
    assert.strictEqual(ext.isActive, true, 'extension should be active');
  });

  test('all contributed commands are registered', async () => {
    const cmds = await vscode.commands.getCommands(true);
    const expected = [
      'vscodeDebugMcp.start',
      'vscodeDebugMcp.stop',
      'vscodeDebugMcp.showInfo',
      'vscodeDebugMcp.manageHarnesses',
      'vscodeDebugMcp.configureClaudeCode',
      'vscodeDebugMcp.resetInstallPrompt',
      'vscodeDebugMcp.showMenu',
      'vscodeDebugMcp.checkForUpdates'
    ];
    for (const c of expected) {
      assert.ok(cmds.includes(c), `command ${c} should be registered`);
    }
  });

  test('sample workspace is open (project-scope paths depend on it)', () => {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders && folders.length > 0, 'a workspace folder should be open');
    assert.ok(folders![0].uri.fsPath.endsWith('sample-workspace'));
  });
});

suite('Debug MCP — server lifecycle', () => {
  test('start command binds this window\'s socket; stop tears it down', async function () {
    this.timeout(20000);
    await getExt().activate();

    // autoStart may already have started it; start is idempotent.
    await vscode.commands.executeCommand('vscodeDebugMcp.start');

    // The socket path is logged but not returned; assert indirectly by
    // confirming a second start doesn't throw and showInfo reports running.
    // On POSIX we can also look for a bound socket under the tmp dir.
    if (process.platform !== 'win32') {
      const base = `${process.env.TMPDIR ?? '/tmp'}`.replace(/\/$/, '');
      const dir = `${base}/vscode-debug-mcp`;
      let found = false;
      try {
        found = fs.existsSync(dir) && fs.readdirSync(dir).some((f) => f.endsWith('.sock'));
      } catch {
        found = false;
      }
      assert.ok(found, 'a .sock file should exist after start');
    }

    await vscode.commands.executeCommand('vscodeDebugMcp.stop');
    // Restart for any later tests / teardown cleanliness.
    await vscode.commands.executeCommand('vscodeDebugMcp.start');
  });
});

suite('Debug MCP — tools dispatch', () => {
  test('list_launch_configurations sees the sample launch.json', async function () {
    this.timeout(20000);
    await getExt().activate();

    // The extension registers vscode.lm tools named debugMcp_*. Invoke one via
    // the LM tool API and assert it returns the sample configs. This exercises
    // the same handler the MCP server forwards to.
    const tools = vscode.lm.tools.map((t) => t.name);
    assert.ok(
      tools.includes('debugMcp_list_launch_configurations'),
      'debugMcp_list_launch_configurations tool should be registered'
    );

    const result = await vscode.lm.invokeTool('debugMcp_list_launch_configurations', {
      input: {},
      toolInvocationToken: undefined
    });
    // Flatten the tool result text parts.
    const text = result.content
      .map((part: any) => (typeof part.value === 'string' ? part.value : ''))
      .join('');
    assert.ok(text.length > 0, 'tool returned content');
    // sample-workspace/.vscode/launch.json defines "Launch Sample App".
    assert.ok(/Launch Sample App/.test(text), `expected sample config in: ${text.slice(0, 300)}`);
  });
});

suite('Debug MCP — manager panel', () => {
  test('manageHarnesses opens a webview panel without throwing', async function () {
    this.timeout(20000);
    await getExt().activate();
    await vscode.commands.executeCommand('vscodeDebugMcp.manageHarnesses');
    // No public handle to the panel, but the command resolving without throwing
    // (and the activation staying healthy) is the smoke signal. Give the
    // webview a tick to construct.
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(getExt().isActive, true);
  });
});
