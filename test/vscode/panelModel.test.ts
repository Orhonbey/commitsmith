import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import type { FileStatus } from '../../src/git/status';
import type { PushInfo } from '../../src/push/push';
import { RECENT_MAX, addRecent, buildPanelModel, type PanelInput, type RecentEntry } from '../../src/vscode/panelModel';

const f = (path: string, index: FileStatus['index'], worktree: FileStatus['worktree'], untracked = false): FileStatus => ({
  path, index, worktree, untracked,
});
const staged = (p: string) => f(p, 'M', '.');
const unstaged = (p: string) => f(p, '.', 'M');
const fresh = (p: string) => f(p, '.', '.', true);
const WIN = 'C:' + String.fromCharCode(92) + 'work' + String.fromCharCode(92) + 'alpha';
const push = (o: Partial<PushInfo> = {}): PushInfo => ({
  branch: 'main', upstream: 'origin/main', ahead: 2, defaultBranch: 'main', remotes: ['origin'], ...o,
});

function input(o: Partial<PanelInput> = {}): PanelInput {
  return {
    ai: { current: 'Claude Code · Haiku', tools: [{ name: 'Claude Code', found: true }, { name: 'Codex', found: false }] },
    repos: [WIN],
    selected: WIN,
    status: [],
    includeUntracked: false,
    push: push(),
    busy: false,
    recent: [],
    ...o,
  };
}

describe('panel model', () => {
  it('staged files win: staged chip is active', () => {
    const m = buildPanelModel(input({ status: [staged('a'), unstaged('b'), unstaged('c')] }));
    assert.equal(m.scope.staged, 1);
    assert.equal(m.scope.all, 2);
    assert.equal(m.scope.active, 'staged');
  });

  it('nothing staged: the all chip is active', () => {
    const m = buildPanelModel(input({ status: [unstaged('b'), unstaged('c')] }));
    assert.equal(m.scope.staged, 0);
    assert.equal(m.scope.all, 2);
    assert.equal(m.scope.active, 'all');
  });

  it('all counts new files only when includeUntracked is on', () => {
    const status = [unstaged('b'), fresh('n1'), fresh('n2')];
    assert.equal(buildPanelModel(input({ status })).scope.all, 1);
    assert.equal(buildPanelModel(input({ status, includeUntracked: true })).scope.all, 3);
  });

  it('new files line: counts left-out untracked files, none when they are included', () => {
    const status = [unstaged('b'), fresh('n1'), fresh('n2')];
    assert.equal(buildPanelModel(input({ status })).scope.leftOut, 2);
    assert.equal(buildPanelModel(input({ status, includeUntracked: true })).scope.leftOut, 0);
  });

  it('new files stay left out when staged files win, even with includeUntracked', () => {
    const status = [staged('a'), fresh('n1')];
    assert.equal(buildPanelModel(input({ status, includeUntracked: true })).scope.leftOut, 1);
  });

  it('a clean tree has empty chips and no line', () => {
    const m = buildPanelModel(input());
    assert.deepEqual(m.scope, { staged: 0, all: 0, active: 'all', leftOut: 0 });
  });

  it('one repository: shown as a name, no choice', () => {
    const m = buildPanelModel(input());
    assert.equal(m.repo.name, 'alpha');
    assert.equal(m.repo.choices.length, 0);
  });

  it('several repositories: a choice list labelled by folder name, with the selected root', () => {
    const m = buildPanelModel(input({ repos: [WIN, '/home/me/beta'], selected: '/home/me/beta' }));
    assert.deepEqual(m.repo.choices, [
      { root: WIN, name: 'alpha' },
      { root: '/home/me/beta', name: 'beta' },
    ]);
    assert.equal(m.repo.selected, '/home/me/beta');
    assert.equal(m.repo.name, 'beta');
  });

  it('no repository at all is flagged', () => {
    const m = buildPanelModel(input({ repos: [], selected: undefined }));
    assert.equal(m.hasRepo, false);
    assert.equal(buildPanelModel(input()).hasRepo, true);
  });

  it('busy flag is passed through', () => {
    assert.equal(buildPanelModel(input({ busy: true })).busy, true);
    assert.equal(buildPanelModel(input()).busy, false);
  });

  it('push line: upstream with commits to push', () => {
    assert.deepEqual(buildPanelModel(input()).push, { kind: 'upstream', upstream: 'origin/main', ahead: 2 });
  });

  it('push line: no upstream but a remote', () => {
    assert.deepEqual(buildPanelModel(input({ push: push({ upstream: undefined, ahead: 3 }) })).push, { kind: 'noUpstream', ahead: 3 });
  });

  it('push line: no remote, unborn and detached use the Push command states', () => {
    assert.deepEqual(buildPanelModel(input({ push: push({ remotes: [], upstream: undefined }) })).push, { kind: 'noRemote' });
    assert.deepEqual(buildPanelModel(input({ push: push({ branch: '', unborn: true, upstream: undefined, ahead: 0 }) })).push, { kind: 'unborn' });
    assert.deepEqual(buildPanelModel(input({ push: push({ branch: '', upstream: undefined, ahead: 0 }) })).push, { kind: 'detached' });
  });

  it('push line: unknown while it has not been read', () => {
    assert.deepEqual(buildPanelModel(input({ push: undefined })).push, { kind: 'unknown' });
  });

  it('ai row is passed through with per-tool found state', () => {
    const m = buildPanelModel(input());
    assert.equal(m.ai.current, 'Claude Code · Haiku');
    assert.deepEqual(m.ai.tools, [{ name: 'Claude Code', found: true }, { name: 'Codex', found: false }]);
  });

  it('recent list is capped at 5, newest first', () => {
    let list: RecentEntry[] = [];
    for (let i = 1; i <= 7; i++) list = addRecent(list, { kind: 'pushed', branch: 'b' + i });
    assert.equal(RECENT_MAX, 5);
    assert.equal(list.length, 5);
    assert.deepEqual(list.map((e) => (e as { branch: string }).branch), ['b7', 'b6', 'b5', 'b4', 'b3']);
    assert.equal(buildPanelModel(input({ recent: list })).recent.length, 5);
  });

  it('addRecent does not mutate its input', () => {
    const a: RecentEntry[] = [{ kind: 'failed', text: 'x' }];
    addRecent(a, { kind: 'failed', text: 'y' });
    assert.equal(a.length, 1);
  });
});
