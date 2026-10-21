import { build } from 'esbuild';

await build({
  entryPoints: ['test/vscode/smoke/runTest.ts', 'test/vscode/smoke/smoke.ts'],
  outdir: 'test/vscode/smoke/dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  logLevel: 'warning',
});
