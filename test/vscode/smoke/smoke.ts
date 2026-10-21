// Runs inside the VS Code extension host (see runTest.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

const COMMANDS = [
  'commitsmith.writeMessage',
  'commitsmith.writeAndCommit',
  'commitsmith.smartSplit',
  'commitsmith.push',
  'commitsmith.pickModel',
];

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('orhonbey.commitsmith');
  assert.ok(ext, 'extension is installed; dev extensions: ' + vscode.extensions.all.filter((e) => !e.id.startsWith('vscode.')).map((e) => e.id).join(','));
  await ext.activate();
  assert.ok(ext.isActive, 'extension activates');

  const all = await vscode.commands.getCommands(true);
  for (const id of COMMANDS) assert.ok(all.includes(id), `${id} is registered`);

  const git = vscode.extensions.getExtension<any>('vscode.git')!.exports.getAPI(1);
  const repoPath = process.env.SMOKE_REPO!;
  for (let i = 0; i < 40 && git.repositories.length === 0; i++) await new Promise((r) => setTimeout(r, 250));
  const repo = git.repositories[0];
  assert.ok(repo, 'the git extension opened the temp repository');

  await vscode.commands.executeCommand('commitsmith.writeMessage');
  const value: string = repo.inputBox.value;
  assert.equal(value, 'feat: smoke test message');

  const staged = execFileSync('git', ['-C', repoPath, 'diff', '--cached', '--name-only']).toString().trim();
  assert.equal(staged, '', 'Write message stages nothing');
  const log = execFileSync('git', ['-C', repoPath, 'log', '--format=%s']).toString().trim();
  assert.equal(log, 'init', 'Write message commits nothing');

  // ---- Smart split: the plan tab opens, and a commit message creates the commits in order ----
  const gitOut = (...a: string[]) => execFileSync('git', ['-C', repoPath, ...a]).toString().trim();
  writeFileSync(join(repoPath, 'b.txt'), 'bee\n'); // untracked: always part of Smart split
  writeFileSync(join(repoPath, 'c.txt'), 'sea\n');
  const plan = {
    groups: [
      { message: 'feat: add b', files: ['b.txt'], reason: 'new file', uncertain: false },
      { message: 'fix: a and c', files: ['a.txt', 'c.txt'], reason: 'together', uncertain: false },
    ],
    unassigned: [],
  };
  process.env.FAKE_OUT = JSON.stringify({ type: 'result', is_error: false, structured_output: plan });
  await vscode.commands.executeCommand('commitsmith.smartSplit');
  const labels = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
  for (let i = 0; i < 40 && !labels().includes('✦ Commit plan'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(labels().includes('✦ Commit plan'), 'the plan tab opened; tabs: ' + labels().join(' | '));
  const held: any = await vscode.commands.executeCommand('commitsmith.test.planTab', { action: 'state' });
  assert.deepEqual(held.plan.groups.map((g: any) => g.files), [['b.txt'], ['a.txt', 'c.txt']]);
  assert.equal(gitOut('log', '--format=%s'), 'init', 'opening the plan commits nothing');

  // A forged message (a file that is not in the plan) is ignored.
  const forged = JSON.parse(JSON.stringify(held.plan));
  forged.groups[0].files.push('../outside.txt');
  await vscode.commands.executeCommand('commitsmith.test.planTab', {
    action: 'message',
    message: { type: 'commit', plan: forged, pushAfter: false },
  });
  assert.equal(gitOut('log', '--format=%s'), 'init', 'a forged commit message does nothing');

  const after: any = await vscode.commands.executeCommand('commitsmith.test.planTab', {
    action: 'message',
    message: { type: 'commit', plan: held.plan, pushAfter: false },
  });
  assert.equal(after.used, true);
  assert.deepEqual(gitOut('log', '--format=%s', '-3').split(/\r?\n/), ['fix: a and c', 'feat: add b', 'init'], 'commits are created in the shown order');
  assert.equal(gitOut('status', '--porcelain'), '', 'everything was committed');

  await vscode.commands.executeCommand('commitsmith.test.planTab', { action: 'message', message: { type: 'cancel' } });
  for (let i = 0; i < 40 && labels().includes('✦ Commit plan'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!labels().includes('✦ Commit plan'), 'Cancel closes the plan tab');
}
