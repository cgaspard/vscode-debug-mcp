#!/usr/bin/env node
// Bundle the extension with esbuild into a single CommonJS file.
// Used by `npm run compile` (also the vsce:prepublish hook) and `npm run watch`.

const esbuild = require('esbuild');
const path = require('path');

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

const config = {
  entryPoints: [path.resolve(__dirname, '..', 'src', 'extension.ts')],
  bundle: true,
  outfile: path.resolve(__dirname, '..', 'out', 'extension.js'),
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // vscode is provided by the host at runtime and must never be bundled.
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  // Preserve original names in stack traces — extensions are small enough
  // that the size win from mangling isn't worth the debugging cost.
  keepNames: true,
  logLevel: 'info'
};

async function run() {
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log('esbuild: watching for changes…');
  } else {
    await esbuild.build(config);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
