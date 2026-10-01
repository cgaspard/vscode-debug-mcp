import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dirname = path.dirname(fileURLToPath(import.meta.url));

// Drives a real VS Code, loads this extension from source, and runs the
// extension-host smoke tests compiled to out-test/test/. The sample workspace
// file includes both workspace and folder launch configurations.
export default defineConfig({
  files: 'out-test/test/**/*.test.js',
  version: 'stable',
  extensionDevelopmentPath: dirname,
  workspaceFolder: path.join(dirname, 'sample-workspace', 'test.code-workspace'),
  launchArgs: ['--disable-extensions'],
  mocha: {
    ui: 'tdd',
    timeout: 30000
  }
});
