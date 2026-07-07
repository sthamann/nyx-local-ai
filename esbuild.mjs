import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * KaTeX ships its stylesheet + fonts as static assets (katex is a bundled
 * devDependency, so its node_modules folder is not packaged into the VSIX).
 * Copy the CSS and the woff2 fonts (the only format Chromium needs) into
 * media/, next to main.js.
 */
function copyKatexAssets() {
  const dist = 'node_modules/katex/dist';
  mkdirSync('media/fonts', { recursive: true });
  cpSync(join(dist, 'katex.min.css'), 'media/katex.min.css');
  for (const font of readdirSync(join(dist, 'fonts'))) {
    if (font.endsWith('.woff2')) {
      cpSync(join(dist, 'fonts', font), join('media/fonts', font));
    }
  }
}

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  outfile: 'dist/extension.js',
  external: ['vscode', 'tesseract.js', 'playwright-core'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ['webview/main.ts'],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  outfile: 'media/main.js',
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

async function run() {
  copyKatexAssets();
  if (watch) {
    const ctxExt = await esbuild.context(extensionConfig);
    const ctxWeb = await esbuild.context(webviewConfig);
    await Promise.all([ctxExt.watch(), ctxWeb.watch()]);
    console.log('[nyx] watching…');
  } else {
    await Promise.all([esbuild.build(extensionConfig), esbuild.build(webviewConfig)]);
    console.log('[nyx] build complete');
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
