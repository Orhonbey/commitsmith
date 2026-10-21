// Runs inside the VS Code extension host (see runTest.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
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
  assert.deepEqual(contributes.views.commitsmith.map((v: any) => v.id), ['commitsmith.panel', 'commitsmith.changes', 'commitsmith.recent'], 'the three views are contributed');
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
  const recent: any[] = await vscode.commands.executeCommand('commitsmith.test.recent');
  const kinds = recent.map((e) => e.kind);
  assert.ok(kinds.includes('committed') && kinds.includes('pushed'), 'Recent lists the commits and the push; got ' + kinds.join(','));
  assert.ok(recent.length <= 5, 'Recent is capped at 5');
  assert.equal(panel.model.busy, false);
  // Forged messages are ignored: an unknown action and a repository that is not open change nothing.
  const forged = await panelState({ type: 'run', action: 'rm -rf' });
  assert.equal(forged.model.repo.selected, panel.model.repo.selected);
  const forged2 = await panelState({ type: 'selectRepo', root: '/not/open' });
  assert.equal(forged2.model.repo.selected, panel.model.repo.selected);

  // ---- Message box: the webview's textarea and the Source Control input box are one value ----
  const typed = await panelState({ type: 'setMessage', value: 'feat: typed in the panel' });
  assert.equal(repo.inputBox.value, 'feat: typed in the panel', 'setMessage writes the Source Control input box');
  assert.equal(typed.model.message, 'feat: typed in the panel');
  repo.inputBox.value = 'fix: typed in Source Control';
  assert.equal((await panelState()).model.message, 'fix: typed in Source Control', 'the panel reads the input box back');
  await panelState({ type: 'setMessage', value: 'x'.repeat(10001) });
  assert.equal(repo.inputBox.value, 'fix: typed in Source Control', 'an over-long message is dropped');
  repo.inputBox.value = '';

  // ---- Changes tree: one staged, one modified, one new file ----
  writeFileSync(join(repoPath, 'b.txt'), 'bee\nstaged\n');
  gitOut('add', 'b.txt');
  writeFileSync(join(repoPath, 'c.txt'), 'sea\nmodified\n');
  writeFileSync(join(repoPath, 'f.txt'), 'fresh\n');
  type Tree = { group: { id: string; count: number; leftOut?: boolean }; children: any[] }[];
  const tree = async (): Promise<Tree> => {
    await repo.status();
    return vscode.commands.executeCommand('commitsmith.test.changes');
  };
  const paths = (t: Tree, id: string) => (t.find((g) => g.group.id === id)?.children ?? []).map((n) => n.item.path);
  const until = async (ok: (t: Tree) => boolean, what: string) => {
    let t = await tree();
    for (let i = 0; i < 50 && !ok(t); i++) {
      await new Promise((r) => setTimeout(r, 100));
      t = await tree();
    }
    assert.ok(ok(t), what + '; tree: ' + JSON.stringify(t.map((g) => [g.group.id, paths(t, g.group.id)])));
    return t;
  };
  let t: Tree = await until((x) => paths(x, 'staged').includes('b.txt') && paths(x, 'changes').includes('c.txt') && paths(x, 'untracked').includes('f.txt'), 'the three groups list their files');
  assert.deepEqual(t.map((g) => g.group.id), ['staged', 'changes', 'untracked'], 'Staged, Changes, New Files in that order');
  assert.deepEqual(paths(t, 'staged'), ['b.txt']);
  assert.deepEqual(paths(t, 'changes'), ['c.txt']);
  assert.deepEqual(paths(t, 'untracked'), ['f.txt']);
  assert.equal(t[2].group.leftOut, true, 'with something staged the New Files group says it is not part of Write + Commit');

  // Stage moves the modified file to Staged, Unstage moves it back.
  await vscode.commands.executeCommand('commitsmith.stage', t[1].children[0]);
  t = await until((x) => paths(x, 'staged').includes('c.txt') && !paths(x, 'changes').includes('c.txt'), 'Stage moves c.txt to Staged');
  await vscode.commands.executeCommand('commitsmith.unstage', t[0].children.find((n: any) => n.item.path === 'c.txt'));
  t = await until((x) => paths(x, 'changes').includes('c.txt') && !paths(x, 'staged').includes('c.txt'), 'Unstage moves c.txt back to Changes');

  // Discard never runs without confirmation, and a new file never offers it.
  const win: any = vscode.window;
  const realWarn = win.showWarningMessage;
  const asked: any[] = [];
  win.showWarningMessage = (...args: any[]) => {
    asked.push(args);
    return Promise.resolve(undefined); // the user cancels the modal
  };
  try {
    await vscode.commands.executeCommand('commitsmith.discard', t[1].children[0]);
    assert.equal(asked.length, 1, 'Discard asks first');
    assert.equal(asked[0][1].modal, true, 'the question is modal');
    assert.equal(readFileSync(join(repoPath, 'c.txt'), 'utf8').replace(/\r/g, ''), 'sea\nmodified\n', 'cancelling keeps the change');
    await vscode.commands.executeCommand('commitsmith.discardAll', t[1].group);
    assert.equal(asked.length, 2, 'Discard all asks first');
    assert.equal(readFileSync(join(repoPath, 'c.txt'), 'utf8').replace(/\r/g, ''), 'sea\nmodified\n', 'cancelling keeps the change');
    await vscode.commands.executeCommand('commitsmith.discard', t[2].children[0]);
    assert.equal(asked.length, 2, 'a new file does not even ask');
    assert.ok(existsSync(join(repoPath, 'f.txt')), 'the new file is untouched');
  } finally {
    win.showWarningMessage = realWarn;
  }
  assert.ok(Array.isArray(await vscode.commands.executeCommand('commitsmith.test.recent')));
  // A forged node is ignored.
  await vscode.commands.executeCommand('commitsmith.stage', { type: 'file', root: '/not/open', item: { path: 'c.txt' } });
  await vscode.commands.executeCommand('commitsmith.stage', { type: 'file', root: repoPath, item: { path: '../escape.txt' } });
  t = await tree();
  assert.deepEqual(paths(t, 'staged'), ['b.txt'], 'forged stage requests change nothing');

  // ---- Fix round: forged discard, blur, renames and merge conflicts ----
  const win2: any = vscode.window;
  const realWarn2 = win2.showWarningMessage;
  let asked2 = 0;
  let answer: unknown;
  win2.showWarningMessage = (...args: any[]) => {
    asked2++;
    return Promise.resolve(answer === 'first-button' ? args[2] : answer);
  };
  try {
    // A forged node that claims a new file / a staged file is discardable gets no modal at all.
    const lie = (path: string) => ({ type: 'file', root: repoPath, item: { kind: 'file', group: 'changes', path, name: path, dir: '', change: 'modified', canDiscard: true } });
    await vscode.commands.executeCommand('commitsmith.discard', lie('f.txt'));
    await vscode.commands.executeCommand('commitsmith.discard', lie('b.txt'));
    assert.equal(asked2, 0, 'a forged discard of an untracked or staged-only file shows no modal');
    assert.ok(existsSync(join(repoPath, 'f.txt')));
    await panelState({ type: 'blur' });

    // Rename: Unstage resets both paths.
    gitOut('reset', '-q');
    gitOut('checkout', '--', '.');
    gitOut('clean', '-fdq');
    gitOut('mv', 'a.txt', 'a2.txt');
    t = await until((x) => paths(x, 'staged').includes('a2.txt'), 'the staged rename is listed');
    const ren = t.find((g) => g.group.id === 'staged')!.children.find((n: any) => n.item.path === 'a2.txt');
    assert.equal(ren.item.origPath, 'a.txt');
    await vscode.commands.executeCommand('commitsmith.unstage', ren);
    t = await until((x) => paths(x, 'staged').length === 0, 'Unstage clears the rename from Staged');
    assert.ok(paths(t, 'changes').includes('a.txt') && paths(t, 'untracked').includes('a2.txt'), 'the old path is a plain deletion and the new one is a new file');
    gitOut('reset', '-q', '--hard');
    gitOut('clean', '-fdq');

    // Merge conflict: its own group; Stage asks "Mark as resolved?".
    gitOut('checkout', '-q', '-b', 'side');
    writeFileSync(join(repoPath, 'c.txt'), 'side\n');
    gitOut('commit', '-q', '-am', 'side');
    gitOut('checkout', '-q', 'topic');
    writeFileSync(join(repoPath, 'c.txt'), 'topic\n');
    gitOut('commit', '-q', '-am', 'topic');
    try { gitOut('merge', 'side'); } catch { /* the conflict is the point */ }
    t = await until((x) => paths(x, 'merge').includes('c.txt'), 'the conflicted file is in Merge Changes');
    assert.equal(t[0].group.id, 'merge', 'Merge Changes is the first group');
    const node = t[0].children[0];
    answer = undefined;
    await vscode.commands.executeCommand('commitsmith.stage', node);
    assert.equal(asked2, 1, 'staging a conflicted file asks');
    t = await tree();
    assert.ok(paths(t, 'merge').includes('c.txt'), 'cancelling leaves it unresolved');
    answer = 'first-button';
    await vscode.commands.executeCommand('commitsmith.stage', node);
    await until((x) => !paths(x, 'merge').includes('c.txt'), 'confirming marks it resolved');
    gitOut('merge', '--abort');
  } finally {
    win2.showWarningMessage = realWarn2;
  }
}
