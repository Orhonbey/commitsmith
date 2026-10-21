import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import {
  CHANGE_STATUS as S,
  MAX_ITEMS_PER_GROUP,
  buildChangeGroups,
  diffTarget,
  type FileItem,
  type RawChange,
} from '../../src/vscode/changesModel';

type Input = Parameters<typeof buildChangeGroups>[0];

const c = (path: string, status: number, origPath?: string): RawChange => ({ path, status, origPath });
const build = (o: Partial<Input> = {}) => buildChangeGroups({ merge: [], index: [], working: [], untracked: [], includeUntracked: false, ...o });
const files = (g: { items: unknown[] }) => g.items.filter((i): i is FileItem => (i as FileItem).kind === 'file');

describe('changes model', () => {
  it('mirrors the git extension Status enum numbers', () => {
    assert.equal(S.INDEX_MODIFIED, 0);
    assert.equal(S.MODIFIED, 5);
    assert.equal(S.UNTRACKED, 7);
    assert.equal(S.BOTH_MODIFIED, 18);
  });

  it('a clean tree has no groups', () => {
    assert.deepEqual(build(), []);
  });

  it('groups staged, changed and new files in that order and hides empty groups', () => {
    const g = build({
      index: [c('a/x.cs', S.INDEX_MODIFIED)],
      working: [c('b.txt', S.MODIFIED)],
      untracked: [c('n.txt', S.UNTRACKED)],
    });
    assert.deepEqual(g.map((x) => x.id), ['staged', 'changes', 'untracked']);
    assert.deepEqual(build({ working: [c('b.txt', S.MODIFIED)] }).map((x) => x.id), ['changes']);
    assert.deepEqual(build({ untracked: [c('n', S.UNTRACKED)] }).map((x) => x.id), ['untracked']);
  });

  it('file item: name, folder, letter, kind', () => {
    const [g] = build({ index: [c('Assets/Scripts/Foo.cs', S.INDEX_MODIFIED)] });
    const f = files(g)[0];
    assert.equal(f.name, 'Foo.cs');
    assert.equal(f.dir, 'Assets/Scripts');
    assert.equal(f.change, 'modified');
    assert.equal(f.group, 'staged');
    assert.equal(files(build({ index: [c('top.txt', S.INDEX_ADDED)] })[0])[0].dir, '');
  });

  it('ignored files are dropped', () => {
    assert.deepEqual(build({ working: [c('x', S.IGNORED)] }), []);
  });

  it('untracked files the API reports only inside workingTreeChanges are still found', () => {
    const g = build({ working: [c('b.txt', S.MODIFIED), c('n.txt', S.UNTRACKED)], untracked: [] });
    assert.deepEqual(g.map((x) => x.id), ['changes', 'untracked']);
    assert.deepEqual(files(g[1]).map((f) => f.path), ['n.txt']);
    assert.equal(files(g[0]).length, 1);
  });

  it('untracked reported twice is listed once', () => {
    const g = build({ working: [c('n.txt', S.UNTRACKED)], untracked: [c('n.txt', S.UNTRACKED)] });
    assert.equal(g.length, 1);
    assert.equal(g[0].count, 1);
  });

  it('new files are left out of Write + Commit when anything is staged or includeUntracked is off', () => {
    const untracked = [c('n', S.UNTRACKED)];
    const flag = (o: Partial<Input>) => build({ untracked, ...o }).find((x) => x.id === 'untracked')!.leftOut;
    assert.equal(flag({}), true);
    assert.equal(flag({ includeUntracked: true }), false);
    assert.equal(flag({ index: [c('s', S.INDEX_MODIFIED)] }), true);
    assert.equal(flag({ includeUntracked: true, index: [c('s', S.INDEX_MODIFIED)] }), true);
  });

  it('a staged rename lists the old path too, so Unstage resets both sides', () => {
    const [g] = build({ index: [c('new/b.cs', S.INDEX_RENAMED, 'old/a.cs'), c('x.cs', S.INDEX_MODIFIED)] });
    assert.deepEqual([...g.paths].sort(), ['new/b.cs', 'old/a.cs', 'x.cs']);
    assert.equal(g.count, 2);
  });

  it('merge conflicts form a read-only group on top, never discardable', () => {
    const g = build({ merge: [c('m.cs', S.BOTH_MODIFIED)], index: [c('s', S.INDEX_MODIFIED)] });
    assert.deepEqual(g.map((x) => x.id), ['merge', 'staged']);
    const f = files(g[0])[0];
    assert.equal(f.change, 'conflict');
    assert.equal(f.canDiscard, false);
    assert.equal(g[0].leftOut, false);
    assert.deepEqual(diffTarget(f), { kind: 'open', title: 'file', side: { ref: 'worktree', path: 'm.cs' } });
  });

  it('a file that only has intent-to-add cannot be discarded', () => {
    const [g] = build({ working: [c('i.cs', S.INTENT_TO_ADD), c('w.cs', S.MODIFIED)] });
    assert.deepEqual(files(g).map((f) => f.canDiscard), [false, true]);
    assert.deepEqual(g.discardPaths, ['w.cs']);
  });

  it('only the Changes group can discard, and not new files', () => {
    const g = build({ index: [c('s', S.INDEX_MODIFIED)], working: [c('w', S.MODIFIED), c('n', S.UNTRACKED)] });
    assert.equal(files(g[0])[0].canDiscard, false);
    assert.equal(files(g[1])[0].canDiscard, true);
    assert.equal(files(g[2])[0].canDiscard, false);
  });

  it('a rename shows the new path and keeps the old one', () => {
    const [g] = build({ index: [c('new/dir/b.cs', S.INDEX_RENAMED, 'old/a.cs')] });
    const f = files(g)[0];
    assert.equal(f.path, 'new/dir/b.cs');
    assert.equal(f.origPath, 'old/a.cs');
    assert.equal(f.name, 'b.cs');
    assert.equal(f.dir, 'new/dir');
    assert.equal(f.change, 'renamed');
  });

  it('items are sorted by path', () => {
    const [g] = build({ working: [c('b/z', S.MODIFIED), c('a/y', S.MODIFIED), c('a/x', S.MODIFIED)] });
    assert.deepEqual(files(g).map((f) => f.path), ['a/x', 'a/y', 'b/z']);
  });

  it('caps a group and appends a "more files" item; the count and paths stay complete', () => {
    const many = Array.from({ length: MAX_ITEMS_PER_GROUP + 37 }, (_, i) => c('f' + String(i).padStart(5, '0'), S.MODIFIED));
    const [g] = build({ working: many });
    assert.equal(MAX_ITEMS_PER_GROUP, 500);
    assert.equal(g.count, 537);
    assert.equal(g.paths.length, 537);
    assert.equal(g.items.length, 501);
    assert.deepEqual(g.items[500], { kind: 'more', count: 37 });
  });

  it('exactly the cap has no more item', () => {
    const many = Array.from({ length: MAX_ITEMS_PER_GROUP }, (_, i) => c('f' + i, S.MODIFIED));
    assert.equal(build({ working: many })[0].items.length, MAX_ITEMS_PER_GROUP);
  });

  describe('diffTarget', () => {
    const item = (o: Partial<FileItem>): FileItem => ({
      kind: 'file', group: 'changes', path: 'a/f.cs', name: 'f.cs', dir: 'a', change: 'modified', canDiscard: true, ...o,
    });

    it('staged: HEAD <-> index', () => {
      assert.deepEqual(diffTarget(item({ group: 'staged' })), {
        kind: 'diff', title: 'headToIndex', left: { ref: 'HEAD', path: 'a/f.cs' }, right: { ref: '', path: 'a/f.cs' },
      });
    });

    it('changes: index <-> working tree', () => {
      assert.deepEqual(diffTarget(item({})), {
        kind: 'diff', title: 'indexToWorktree', left: { ref: '', path: 'a/f.cs' }, right: { ref: 'worktree', path: 'a/f.cs' },
      });
    });

    it('new file opens the file itself', () => {
      assert.deepEqual(diffTarget(item({ group: 'untracked', change: 'untracked' })), {
        kind: 'open', title: 'file', side: { ref: 'worktree', path: 'a/f.cs' },
      });
    });

    it('deleted files show the old version', () => {
      assert.deepEqual(diffTarget(item({ group: 'staged', change: 'deleted' })), { kind: 'open', title: 'head', side: { ref: 'HEAD', path: 'a/f.cs' } });
      assert.deepEqual(diffTarget(item({ change: 'deleted' })), { kind: 'open', title: 'index', side: { ref: '', path: 'a/f.cs' } });
    });

    it('a staged new file opens its index version', () => {
      assert.deepEqual(diffTarget(item({ group: 'staged', change: 'added' })), { kind: 'open', title: 'index', side: { ref: '', path: 'a/f.cs' } });
    });

    it('a staged rename compares the old path in HEAD with the new path in the index', () => {
      assert.deepEqual(diffTarget(item({ group: 'staged', change: 'renamed', origPath: 'old/f.cs' })), {
        kind: 'diff', title: 'headToIndex', left: { ref: 'HEAD', path: 'old/f.cs' }, right: { ref: '', path: 'a/f.cs' },
      });
    });
  });
});
