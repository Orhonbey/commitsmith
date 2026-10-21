import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { readStatus } from '../../src/git/status';
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
});
