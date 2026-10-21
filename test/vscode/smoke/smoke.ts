// Runs inside the VS Code extension host (see runTest.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';

const COMMANDS = [
  'commitsmith.writeMessage',
  'commitsmith.writeAndCommit',
  'commitsmith.smartSplit',
  'commitsmith.push',
  'commitsmith.pickModel',
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('orhonbey.commitsmith');
  assert.ok(ext, 'extension is installed; dev extensions: ' + vscode.extensions.all.filter((e) => !e.id.startsWith('vscode.')).map((e) => e.id).join(','));
  await ext.activate();
  assert.ok(ext.isActive, 'extension activates');

  const all = await vscode.commands.getCommands(true);
  for (const id of COMMANDS) assert.ok(all.includes(id), `${id} is registered`);

  const git = vscode.extensions.getExtension<any>('vscode.git')!.exports.getAPI(1);
  const repoPath = process.env.SMOKE_REPO!;
  for (let i = 0; i < 40 && git.repositories.length === 0; i++) await sleep(250);
  const repo = git.repositories[0];
  assert.ok(repo, 'the git extension opened the temp repository');

  let value = '';
  for (let attempt = 0; attempt < 8 && !value; attempt++) {
    await vscode.commands.executeCommand('commitsmith.writeMessage');
    value = repo.inputBox.value;
    if (!value) await sleep(1000); // tool detection may still be running right after activation
  }
  assert.equal(value, 'feat: smoke test message');

  const staged = execFileSync('git', ['-C', repoPath, 'diff', '--cached', '--name-only']).toString().trim();
  assert.equal(staged, '', 'Write message stages nothing');
  const log = execFileSync('git', ['-C', repoPath, 'log', '--format=%s']).toString().trim();
  assert.equal(log, 'init', 'Write message commits nothing');
}
