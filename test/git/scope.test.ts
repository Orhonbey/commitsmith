import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { join } from 'node:path';
import { runGit } from '../../src/git/gitRunner';
import { parseStatus, readStatus } from '../../src/git/status';
import { resolveScope, scopeAction } from '../../src/git/scope';
import { createTempRepo, type TempRepo } from '../helpers/tempRepo';

describe('resolveScope', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const paths = (s: { files: { path: string }[] }) => s.files.map((f) => f.path);

  it('staged scope wins', async () => {
    repo.write('a.txt', 'a2\n');
    repo.write('b.txt', 'b2\n');
    await repo.git('add', 'a.txt');
    repo.write('c.txt', 'c\n');
    const scope = resolveScope(await readStatus(repo.root), { includeUntracked: false });
    assert.equal(scope.kind, 'staged');
    assert.deepEqual(paths(scope), ['a.txt']);
  });

  it('partial stage stays staged scope', async () => {
    repo.write('a.txt', 'a2\n');
    await repo.git('add', 'a.txt');
    repo.write('a.txt', 'a3\n');
    const scope = resolveScope(await readStatus(repo.root), { includeUntracked: false });
    assert.equal(scope.kind, 'staged');
    assert.deepEqual(paths(scope), ['a.txt']);
  });

  it('all scope excludes untracked by default', async () => {
    repo.write('a.txt', 'a2\n');
    repo.write('c.txt', 'c\n');
    const scope = resolveScope(await readStatus(repo.root), { includeUntracked: false });
    assert.equal(scope.kind, 'all');
    assert.deepEqual(paths(scope), ['a.txt']);
    assert.deepEqual(scope.leftOutUntracked, ['c.txt']);
  });

  it('includeUntracked adds new files', async () => {
    repo.write('a.txt', 'a2\n');
    repo.write('c.txt', 'c\n');
    const scope = resolveScope(await readStatus(repo.root), { includeUntracked: true });
    assert.equal(scope.kind, 'all');
    assert.deepEqual(paths(scope), ['a.txt', 'c.txt']);
    assert.equal(scope.files[1].isNew, true);
    assert.deepEqual(scope.leftOutUntracked, []);
  });

  it('rename keeps origPath', async () => {
    repo.write('sub/.keep', '');
    await repo.git('mv', 'a.txt', 'sub/a2.txt');
    const scope = resolveScope(await readStatus(repo.root), { includeUntracked: false });
    assert.equal(scope.kind, 'staged');
    const f = scope.files.find((x) => x.path === 'sub/a2.txt');
    assert.ok(f);
    assert.equal(f.origPath, 'a.txt');
    assert.equal(f.change, 'renamed');
  });

  it('odd paths round-trip', async () => {
    const odd = ['Oswald-Medium SDF.asset', 'Ödeme ü.cs'];
    const r = await createTempRepo({ [odd[0]]: 'x\n', [odd[1]]: 'y\n' });
    try {
      r.write(odd[0], 'x2\n');
      r.write(odd[1], 'y2\n');
      const scope = resolveScope(await readStatus(r.root), { includeUntracked: false });
      assert.deepEqual(paths(scope).sort(), [...odd].sort());
    } finally {
      await r.cleanup();
    }
  });
  it('only new files: Write message offers them instead of "nothing to describe" (I4)', async () => {
    repo.write('n.txt', 'n\n');
    const scope = resolveScope(await readStatus(repo.root), { includeUntracked: false });
    assert.equal(scopeAction(scope), 'offerNewFiles');
    assert.equal(scopeAction(resolveScope(await readStatus(repo.root), { includeUntracked: true })), 'describe');
    repo.write('a.txt', 'a2\n');
    assert.equal(scopeAction(resolveScope(await readStatus(repo.root), { includeUntracked: false })), 'describe');
    assert.equal(scopeAction({ kind: 'all', files: [], leftOutUntracked: [] }), 'nothing');
  });

  describe('submodules (#1)', () => {
    const inSub = (...args: string[]) => runGit(join(repo.root, 'sub'), args);
    beforeEach(async () => {
      repo.write('sub/x.txt', 'x\n');
      await inSub('init', '-b', 'main');
      await inSub('config', 'user.name', 'Test User');
      await inSub('config', 'user.email', 'test@example.com');
      await inSub('config', 'commit.gpgsign', 'false');
      await inSub('add', '-A');
      await inSub('commit', '-m', 'sub init');
    });

    it('a staged new submodule is in scope', async () => {
      await repo.git('add', 'sub');
      const scope = resolveScope(await readStatus(repo.root), { includeUntracked: false });
      assert.equal(scope.kind, 'staged');
      assert.deepEqual(paths(scope), ['sub']);
    });

    describe('committed in the parent', () => {
      beforeEach(async () => {
        await repo.git('add', 'sub');
        await repo.git('commit', '-m', 'add sub');
      });

      it('edited or new files inside it, same commit: left out, nothing to commit', async () => {
        repo.write('sub/x.txt', 'x2\n');
        repo.write('sub/y.txt', 'y\n');
        const scope = resolveScope(await readStatus(repo.root), { includeUntracked: true });
        assert.deepEqual(paths(scope), []);
        assert.equal(scopeAction(scope), 'nothing');
      });

      it('dirty content next to a real change: only the real change', async () => {
        repo.write('sub/x.txt', 'x2\n');
        repo.write('a.txt', 'a2\n');
        const scope = resolveScope(await readStatus(repo.root), { includeUntracked: false });
        assert.deepEqual(paths(scope), ['a.txt']);
      });

      it('a new commit checked out inside it is in scope', async () => {
        repo.write('sub/x.txt', 'x2\n');
        await inSub('commit', '-am', 'sub change');
        repo.write('sub/x.txt', 'x3\n');
        const scope = resolveScope(await readStatus(repo.root), { includeUntracked: false });
        assert.deepEqual(paths(scope), ['sub']);
        assert.equal(scope.files[0].change, 'modified');
      });
    });
  });
});

describe('parseStatus submodule field', () => {
  it('drops a submodule whose only change is its content, keeps index changes and new commits', () => {
    const raw = [
      '1 .M S.M. 160000 160000 160000 aaa aaa dirty',
      '1 .M S..U 160000 160000 160000 aaa aaa untracked-inside',
      '1 .M SC.. 160000 160000 160000 aaa aaa moved',
      '1 A. S... 000000 160000 160000 000 bbb added',
      '1 AM S.M. 000000 160000 160000 000 bbb added-dirty',
      '1 .M N... 100644 100644 100644 ccc ccc file.txt',
      '',
    ].join('\0');
    const got = parseStatus(raw).map((s) => `${s.path} ${s.index}${s.worktree}`);
    assert.deepEqual(got, ['moved .M', 'added A.', 'added-dirty A.', 'file.txt .M']);
  });
});
