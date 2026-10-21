// Launches a real VS Code (downloaded into .vscode-test/) and runs smoke.ts inside it.
// Run with `npm run test:vscode`; it is not part of `npm test`.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

const root = resolve(__dirname, '../../../..');

async function main() {
  // Launched from inside another VS Code / Electron app these leak in and confuse the new instance.
  delete process.env.ELECTRON_RUN_AS_NODE;
  for (const k of Object.keys(process.env)) if (k.startsWith('VSCODE_')) delete process.env[k];
  const dir = mkdtempSync(join(tmpdir(), 'commitsmith-smoke-'));
  const repo = join(dir, 'repo');
  const git = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { stdio: 'pipe' });
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'pipe' });
  git('config', 'user.name', 'Smoke');
  git('config', 'user.email', 'smoke@example.com');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-m', 'init');
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n'); // unstaged change

  // Stand-in for the Claude CLI: the repo's fake-ai.mjs behind a shim.
  const fake = join(root, 'test/fixtures/fake-ai.mjs');
  const win = process.platform === 'win32';
  const shim = join(dir, win ? 'fake-claude.cmd' : 'fake-claude.sh');
  writeFileSync(shim, win ? `@echo off\r\nnode "${fake}" %*\r\n` : `#!/bin/sh\nexec node "${fake}" "$@"\n`, { mode: 0o755 });

  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: join(__dirname, 'smoke.js'),
    launchArgs: [repo, '--disable-workspace-trust', '--user-data-dir', join(dir, 'user'), '--extensions-dir', join(dir, 'ext')],
    extensionTestsEnv: {
      COMMITSMITH_EXE_OVERRIDE: shim,
      FAKE_MODE: 'ok',
      FAKE_OUT: JSON.stringify({ type: 'result', is_error: false, result: 'feat: smoke test message' }),
      SMOKE_REPO: repo,
    },
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
