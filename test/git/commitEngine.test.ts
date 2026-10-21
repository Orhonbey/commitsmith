import assert from 'node:assert/strict';
import { chmodSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { commitGroups } from '../../src/git/commitEngine';
import { createTempRepo, type TempRepo } from '../helpers/tempRepo';

describe('commitEngine', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const headFiles = async () => (await repo.git('ls-tree', '-r', '--name-only', 'HEAD')).split('\n');
  const noTempIndex = () =>
    assert.ok(!readdirSync(join(repo.root, '.git')).some((f) => f.startsWith('commitsmith-index')));

  it('staged commit takes only staged content', async () => {
    repo.write('a.txt', 'one\n');
    await repo.git('add', 'a.txt');
    repo.write('a.txt', 'one\ntwo\n');
    const res = await commitGroups(repo.root, 'staged', [{ message: 'm', paths: ['a.txt'] }]);
    assert.equal(res.failed, undefined);
    assert.equal(res.done.length, 1);
    const head = await repo.git('show', 'HEAD:a.txt');
    assert.ok(head.includes('one') && !head.includes('two'));
    assert.ok((await repo.git('diff')).includes('+two'));
    assert.equal((await repo.git('diff', '--cached')).trim(), '');
    assert.equal(res.done[0].sha, (await repo.git('rev-parse', 'HEAD')).trim());
    noTempIndex();
  });

  it('other staged files stay staged', async () => {
    repo.write('a.txt', 'a2\n');
    repo.write('b.txt', 'b2\n');
    await repo.git('add', 'a.txt', 'b.txt');
    const res = await commitGroups(repo.root, 'staged', [{ message: 'm', paths: ['a.txt'] }]);
    assert.equal(res.failed, undefined);
    assert.equal((await repo.git('show', 'HEAD:a.txt')).trim(), 'a2');
    assert.equal((await repo.git('show', 'HEAD:b.txt')).trim(), 'b');
    assert.equal((await repo.git('diff', '--cached', '--name-only')).trim(), 'b.txt');
  });

  for (const kind of ['staged', 'all'] as const) {
    it(`empty paths fail without touching anything (${kind})`, async () => {
      repo.write('a.txt', 'a2\n');
      repo.write('b.txt', 'b2\n');
      repo.write('n.txt', 'n\n');
      await repo.git('add', 'b.txt');
      const head = (await repo.git('rev-parse', 'HEAD')).trim();
      const res = await commitGroups(repo.root, kind, [{ message: 'm', paths: [] }]);
      assert.equal(res.done.length, 0);
      assert.equal(res.failed?.index, 0);
      assert.equal((await repo.git('rev-parse', 'HEAD')).trim(), head);
      assert.equal((await repo.git('diff', '--cached', '--name-only')).trim(), 'b.txt');
    });
  }

  it('hook that stages another file leaves no stale index entry', async () => {
    repo.write('.git/hooks/pre-commit', '#!/bin/sh\necho hooked > c.txt\ngit add c.txt\nexit 0\n');
    chmodSync(join(repo.root, '.git', 'hooks', 'pre-commit'), 0o755);
    repo.write('a.txt', 'a2\n');
    const res = await commitGroups(repo.root, 'all', [{ message: 'm', paths: ['a.txt'] }]);
    assert.equal(res.failed, undefined);
    assert.equal((await repo.git('show', 'HEAD:c.txt')).trim(), 'hooked');
    assert.equal((await repo.git('status', '--porcelain')).trim(), '');
  });

  it('failed index refresh is reported as committed', async () => {
    repo.write('.git/hooks/post-commit', '#!/bin/sh\ntouch "$(git rev-parse --absolute-git-dir)/index.lock"\nexit 0\n');
    chmodSync(join(repo.root, '.git', 'hooks', 'post-commit'), 0o755);
    repo.write('a.txt', 'a2\n');
    const res = await commitGroups(repo.root, 'all', [{ message: 'm', paths: ['a.txt'] }]);
    assert.equal(res.done.length, 1);
    assert.equal(res.failed?.committed, true);
    assert.equal(res.failed?.index, 0);
    rmSync(join(repo.root, '.git', 'index.lock'), { force: true });
  });

  it('refuses while a merge is in progress', async () => {
    repo.write('.git/MERGE_HEAD', (await repo.git('rev-parse', 'HEAD')).trim() + '\n');
    repo.write('a.txt', 'a2\n');
    const res = await commitGroups(repo.root, 'all', [{ message: 'm', paths: ['a.txt'] }]);
    assert.equal(res.done.length, 0);
    assert.equal(res.failed?.index, 0);
    assert.ok(res.failed?.error.includes('in progress'));
  });

  it('ignores an inherited GIT_INDEX_FILE', async () => {
    const saved = process.env.GIT_INDEX_FILE;
    repo.write('a.txt', 'a2\n');
    await repo.git('add', 'a.txt');
    process.env.GIT_INDEX_FILE = join(repo.root, 'bogus-index');
    try {
      const res = await commitGroups(repo.root, 'staged', [{ message: 'm', paths: ['a.txt'] }]);
      assert.equal(res.failed, undefined);
    } finally {
      if (saved === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = saved;
    }
    assert.equal((await repo.git('status', '--porcelain')).trim(), '');
    assert.ok(!existsSync(join(repo.root, 'bogus-index')));
  });

  it('all scope, three groups in order', async () => {
    repo.write('a.txt', 'a2\n');
    repo.write('b.txt', 'b2\n');
    repo.write('c.txt', 'c2\n');
    const res = await commitGroups(repo.root, 'all', [
      { message: 'm1', paths: ['a.txt'] },
      { message: 'm2', paths: ['b.txt'] },
      { message: 'm3', paths: ['c.txt'] },
    ]);
    assert.equal(res.done.length, 3);
    assert.deepEqual((await repo.git('log', '--format=%s', '-3')).trim().split('\n'), ['m3', 'm2', 'm1']);
    assert.equal((await repo.git('status', '--porcelain')).trim(), '');
  });

  it('new file and deletion', async () => {
    repo.write('n.txt', 'n\n');
    rmSync(join(repo.root, 'a.txt'));
    const res = await commitGroups(repo.root, 'all', [{ message: 'm', paths: ['n.txt', 'a.txt'] }]);
    assert.equal(res.failed, undefined);
    const files = await headFiles();
    assert.ok(files.includes('n.txt'));
    assert.ok(!files.includes('a.txt'));
    assert.equal((await repo.git('status', '--porcelain')).trim(), '');
  });

  it('staged deletion', async () => {
    await repo.git('rm', '-q', 'a.txt');
    const res = await commitGroups(repo.root, 'staged', [{ message: 'm', paths: ['a.txt'] }]);
    assert.equal(res.failed, undefined);
    assert.ok(!(await headFiles()).includes('a.txt'));
    assert.equal((await repo.git('status', '--porcelain')).trim(), '');
  });

  it('rename both sides', async () => {
    await repo.git('mv', 'a.txt', 'd.txt');
    const res = await commitGroups(repo.root, 'staged', [{ message: 'm', paths: ['d.txt', 'a.txt'] }]);
    assert.equal(res.failed, undefined);
    const files = await headFiles();
    assert.ok(files.includes('d.txt'));
    assert.ok(!files.includes('a.txt'));
    assert.equal((await repo.git('status', '--porcelain')).trim(), '');
  });

  it('hook rejects 2nd group', async () => {
    const hook = join(repo.root, '.git', 'hooks', 'pre-commit');
    repo.write(
      '.git/hooks/pre-commit',
      '#!/bin/sh\nif git diff --cached --name-only | grep -q "^b.txt$"; then echo "HOOK-SAYS-NO"; exit 1; fi\nexit 0\n',
    );
    chmodSync(hook, 0o755);
    repo.write('a.txt', 'a2\n');
    repo.write('b.txt', 'b2\n');
    repo.write('c.txt', 'c2\n');
    const res = await commitGroups(repo.root, 'all', [
      { message: 'm1', paths: ['a.txt'] },
      { message: 'm2', paths: ['b.txt'] },
      { message: 'm3', paths: ['c.txt'] },
    ]);
    assert.equal(res.done.length, 1);
    assert.equal(res.failed?.index, 1);
    assert.equal(res.failed?.message, 'm2');
    assert.ok(res.failed?.error.includes('HOOK-SAYS-NO'), res.failed?.error);
    const status = (await repo.git('status', '--porcelain')).split('\n').filter(Boolean);
    assert.deepEqual(status.sort(), [' M b.txt', ' M c.txt']);
    assert.equal((await repo.git('diff', '--cached', '--name-only')).trim(), '');
    noTempIndex();
  });

  it('cancelled signal stops before the next group', async () => {
    repo.write('a.txt', 'a2\n');
    const ac = new AbortController();
    ac.abort();
    const res = await commitGroups(repo.root, 'all', [{ message: 'm1', paths: ['a.txt'] }], ac.signal);
    assert.equal(res.done.length, 0);
    assert.equal(res.failed?.index, 0);
    assert.equal(res.failed?.error, 'cancelled');
  });

  it('group equal to HEAD fails with git message', async () => {
    const res = await commitGroups(repo.root, 'all', [{ message: 'm', paths: ['a.txt'] }]);
    assert.equal(res.done.length, 0);
    assert.equal(res.failed?.index, 0);
    assert.ok((res.failed?.error ?? '').length > 0);
    noTempIndex();
  });

  it('no HEAD yet', async () => {
    const fresh = await createTempRepo();
    try {
      fresh.write('a.txt', 'a\n');
      const res = await commitGroups(fresh.root, 'all', [{ message: 'first', paths: ['a.txt'] }]);
      assert.equal(res.failed, undefined);
      assert.equal(res.done.length, 1);
      assert.equal((await fresh.git('log', '--format=%s')).trim(), 'first');
      assert.equal((await fresh.git('status', '--porcelain')).trim(), '');
    } finally {
      await fresh.cleanup();
    }
  });

  it('odd paths', async () => {
    repo.write('Oswald-Medium SDF.asset', 'x\n');
    repo.write('Ödeme ü.cs', 'y\n');
    const res = await commitGroups(repo.root, 'all', [
      { message: 'm', paths: ['Oswald-Medium SDF.asset', 'Ödeme ü.cs'] },
    ]);
    assert.equal(res.failed, undefined);
    assert.equal((await repo.git('status', '--porcelain')).trim(), '');
    const files = await headFiles();
    assert.ok(files.includes('Ödeme ü.cs'));
    assert.ok(files.includes('Oswald-Medium SDF.asset'));
  });

  it('600 files in one group', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 600; i++) {
      const p = `dir/file-${i}.txt`;
      repo.write(p, `${i}\n`);
      paths.push(p);
    }
    const res = await commitGroups(repo.root, 'all', [{ message: 'many', paths }]);
    assert.equal(res.failed, undefined);
    assert.equal((await repo.git('status', '--porcelain')).trim(), '');
    assert.ok(existsSync(join(repo.root, 'dir/file-599.txt')));
  });
});
