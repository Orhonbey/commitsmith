// Runs inside the VS Code extension host (see runTest.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';

const COMMANDS = [
  'commitsmith.writeMessage',
  'commitsmith.writeAndCommit',
  'commitsmith.smartSplit',
  'commitsmith.push',
  'commitsmith.pickModel',
];

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('commitsmith.commitsmith');
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

  const planTab = (message?: unknown): Thenable<any> =>
    vscode.commands.executeCommand('commitsmith.test.planTab', message ? { action: 'message', message } : { action: 'state' });

  // A commit built against another plan revision is ignored.
  await planTab({ type: 'commit', revision: held.revision + 1, pushAfter: false });
  assert.equal(gitOut('log', '--format=%s'), 'init', 'a commit with a stale revision does nothing');

  // A change made after the plan was made marks it stale, and undoing it clears the mark.
  const untilStale = async (want: boolean) => {
    for (let i = 0; i < 100 && (await planTab()).stale !== want; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal((await planTab()).stale, want, 'stale should be ' + want);
  };
  assert.equal(held.stale, false);
  writeFileSync(join(repoPath, 'd.txt'), 'dee');
  await untilStale(true);
  await planTab({ type: 'commit', revision: held.revision, pushAfter: false });
  assert.equal(gitOut('log', '--format=%s'), 'init', 'a stale plan cannot be committed');
  unlinkSync(join(repoPath, 'd.txt'));
  await untilStale(false);

  const after: any = await planTab({ type: 'commit', revision: held.revision, pushAfter: false });
  assert.equal(after.used, true);
  assert.deepEqual(gitOut('log', '--format=%s', '-3').split(/\r?\n/), ['fix: a and c', 'feat: add b', 'init'], 'commits are created in the shown order');
  assert.equal(gitOut('status', '--porcelain'), '', 'everything was committed');

  await vscode.commands.executeCommand('commitsmith.test.planTab', { action: 'message', message: { type: 'cancel' } });
  for (let i = 0; i < 40 && labels().includes('✦ Commit plan'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(!labels().includes('✦ Commit plan'), 'Cancel closes the plan tab');

  // ---- Push goes through the git extension (repo.push), to a non-default branch: no confirmation ----
  const bare = join(repoPath, '..', 'remote.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare]);
  gitOut('remote', 'add', 'origin', bare);
  gitOut('checkout', '-q', '-b', 'topic');
  gitOut('push', '-q', '-u', 'origin', 'topic');
  writeFileSync(join(repoPath, 'e.txt'), 'e\n');
  gitOut('add', 'e.txt');
  gitOut('commit', '-q', '-m', 'feat: e');
  for (let i = 0; i < 40 && repo.state.HEAD?.name !== 'topic'; i++) await new Promise((r) => setTimeout(r, 100));
  await vscode.commands.executeCommand('commitsmith.push');
  const remoteTopic = execFileSync('git', ['-C', bare, 'rev-parse', 'topic']).toString().trim();
  assert.equal(remoteTopic, gitOut('rev-parse', 'HEAD'), 'commitsmith.push pushed the new commit');
  // ---- Activity Bar panel: the container and view are contributed, the view resolves, the model is live ----
  const contributes = ext.packageJSON.contributes;
  assert.equal(contributes.viewsContainers.activitybar[0].id, 'commitsmith', 'the commitsmith view container is contributed');
  assert.equal(contributes.views.commitsmith[0].id, 'commitsmith.panel', 'the commitsmith.panel view is contributed');
  await vscode.commands.executeCommand('workbench.view.extension.commitsmith');
  const panelState = (message?: unknown): Thenable<any> => vscode.commands.executeCommand('commitsmith.test.panel', message ? { message } : {});
  let panel: any;
  for (let i = 0; i < 60; i++) {
    panel = await panelState();
    if (panel.resolved > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(panel.resolved > 0, 'the panel provider resolved its view');
  assert.equal(panel.model.hasRepo, true);
  assert.equal(panel.model.repo.name, basename(repoPath));
  assert.equal(panel.model.push.kind, 'upstream', 'the push line reads the branch upstream');
  const kinds = panel.model.recent.map((e: any) => e.kind);
  assert.ok(kinds.includes('committed') && kinds.includes('pushed'), 'Recent lists the commits and the push; got ' + kinds.join(','));
  assert.ok(panel.model.recent.length <= 5, 'Recent is capped at 5');
  assert.equal(panel.model.busy, false);
  // Forged messages are ignored: an unknown action and a repository that is not open change nothing.
  const forged = await panelState({ type: 'run', action: 'rm -rf' });
  assert.equal(forged.model.repo.selected, panel.model.repo.selected);
  const forged2 = await panelState({ type: 'selectRepo', root: '/not/open' });
  assert.equal(forged2.model.repo.selected, panel.model.repo.selected);
}
