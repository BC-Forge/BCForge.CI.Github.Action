import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node24',
  outfile: 'dist/index.js',
  minify: true,
  sourcemap: false,
  // Mark node built-ins as external
  external: ['node:*'],
});

console.log('[bcforge-action] build complete');
