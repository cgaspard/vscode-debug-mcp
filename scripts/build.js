#!/usr/bin/env node
// Bundle the extension with esbuild into a single CommonJS file.
// Used by `npm run compile` (also the vsce:prepublish hook) and `npm run watch`.

const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  // Preserve original names in stack traces — extensions are small enough
  // that the size win from mangling isn't worth the debugging cost.
  keepNames: true,
  logLevel: 'info'
};

const extensionConfig = {
  ...shared,
  entryPoints: [path.resolve(__dirname, '..', 'src', 'extension.ts')],
  outfile: path.resolve(__dirname, '..', 'out', 'extension.js'),
  // vscode is provided by the host at runtime and must never be bundled.
  external: ['vscode']
};

// Standalone stdio<->socket bridge spawned by `claude`. No vscode dependency —
// it runs as a plain Node subprocess outside the extension host.
const bridgeConfig = {
  ...shared,
  entryPoints: [path.resolve(__dirname, '..', 'src', 'bridge.ts')],
  outfile: path.resolve(__dirname, '..', 'out', 'bridge.js')
};

async function run() {
  if (watch) {
    const ctxs = await Promise.all([
      esbuild.context(extensionConfig),
      esbuild.context(bridgeConfig)
    ]);
    await Promise.all(ctxs.map((c) => c.watch()));
    console.log('esbuild: watching for changes…');
  } else {
    await Promise.all([
      esbuild.build(extensionConfig),
      esbuild.build(bridgeConfig)
    ]);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
