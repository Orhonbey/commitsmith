import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { decidePush, readPushInfo, runPush, type PushInfo } from '../../src/push/push';
import { runGit } from '../../src/git/gitRunner';
import { createTempRepo, type TempRepo } from '../helpers/tempRepo';

describe('push', () => {
  let repo: TempRepo;
  let bare: string;
  beforeEach(async () => {
    repo = await createTempRepo({ 'a.txt': 'a\n' });
    bare = await mkdtemp(join(tmpdir(), 'commitsmith-bare-'));
    await runGit(bare, ['init', '--bare', '-b', 'main']);
  });
  afterEach(async () => {
    await repo.cleanup();
    await rm(bare, { recursive: true, force: true });
  });

  const commit = async (name: string) => {
    repo.write(name, name + '\n');
    await repo.git('add', '-A');
    await repo.git('commit', '-m', name);
  };
  const withOrigin = async () => {
    await repo.git('remote', 'add', 'origin', bare);
    await repo.git('push', '-u', 'origin', 'main');
  };
  const info = (o: Partial<PushInfo>): PushInfo => ({
    branch: 'main', upstream: 'origin/main', ahead: 1, defaultBranch: 'main', remotes: ['origin'], ...o,
  });

  it('ahead count after two commits is 2', async () => {
    await withOrigin();
    await commit('b.txt');
    await commit('c.txt');
    const i = await readPushInfo(repo.root);
    assert.equal(i.ahead, 2);
    assert.equal(i.upstream, 'origin/main');
    assert.equal(i.branch, 'main');
    assert.deepEqual(i.remotes, ['origin']);
  });

  it('main is default and needs confirm', async () => {
    await withOrigin();
    await commit('b.txt');
    const i = await readPushInfo(repo.root);
    assert.equal(i.defaultBranch, 'main');
    assert.deepEqual(decidePush(i), { kind: 'push', confirmDefault: true });
  });

  it('confirmDefault follows the upstream target: feature tracking origin/main confirms', () => {
    assert.deepEqual(decidePush(info({ branch: 'feature', upstream: 'origin/main' })), { kind: 'push', confirmDefault: true });
    assert.deepEqual(decidePush(info({ branch: 'main', upstream: 'origin/feature' })), { kind: 'push', confirmDefault: false });
  });

  it('unborn HEAD is flagged, detached HEAD is not', async () => {
    const empty = await createTempRepo();
    try {
      const i = await readPushInfo(empty.root);
      assert.equal(i.branch, '');
      assert.equal(i.unborn, true);
    } finally {
      await empty.cleanup();
    }
    await withOrigin();
    await repo.git('checkout', '--detach');
    assert.equal((await readPushInfo(repo.root)).unborn, false);
  });

  it('feature branch no confirm', async () => {
    await withOrigin();
    await repo.git('checkout', '-b', 'feat/x');
    await repo.git('push', '-u', 'origin', 'feat/x');
    await commit('b.txt');
    const i = await readPushInfo(repo.root);
    assert.equal(i.branch, 'feat/x');
    assert.deepEqual(decidePush(i), { kind: 'push', confirmDefault: false });
  });

  it('no upstream -> setUpstream origin', async () => {
    await withOrigin();
    await repo.git('checkout', '-b', 'topic');
    await commit('b.txt');
    const i = await readPushInfo(repo.root);
    assert.equal(i.upstream, undefined);
    assert.equal(i.ahead, 1);
    assert.deepEqual(decidePush(i), { kind: 'setUpstream', remote: 'origin' });
  });

  it('ahead 0 -> nothing', async () => {
    await withOrigin();
    const i = await readPushInfo(repo.root);
    assert.equal(i.ahead, 0);
    assert.deepEqual(decidePush(i), { kind: 'nothing' });
  });

  it('no remotes -> noRemote', async () => {
    const i = await readPushInfo(repo.root);
    assert.deepEqual(i.remotes, []);
    assert.deepEqual(decidePush(i), { kind: 'noRemote' });
  });

  it('decidePush picks first remote when origin is absent, nothing for empty branch', () => {
    assert.deepEqual(decidePush(info({ upstream: undefined, remotes: ['up', 'fork'] })), { kind: 'setUpstream', remote: 'up' });
    assert.deepEqual(decidePush(info({ branch: '' })), { kind: 'nothing' });
  });

  it('detached HEAD gives empty branch -> nothing', async () => {
    await withOrigin();
    await repo.git('checkout', '--detach');
    const i = await readPushInfo(repo.root);
    assert.equal(i.branch, '');
    assert.deepEqual(decidePush(i), { kind: 'nothing' });
  });

  it('no commits yet -> ahead 0', async () => {
    const empty = await createTempRepo();
    try {
      await empty.git('remote', 'add', 'origin', bare);
      const i = await readPushInfo(empty.root);
      assert.equal(i.ahead, 0);
      assert.deepEqual(decidePush(i), { kind: 'nothing' });
    } finally {
      await empty.cleanup();
    }
  });

  it('runPush setUpstream pushes and sets @{u}', async () => {
    await repo.git('remote', 'add', 'origin', bare);
    await runPush(repo.root, { kind: 'setUpstream', remote: 'origin' }, 'main');
    const u = (await repo.git('rev-parse', '--abbrev-ref', '@{u}')).trim();
    assert.equal(u, 'origin/main');
    const remoteHead = (await runGit(bare, ['rev-parse', 'main'])).stdout.trim();
    assert.equal(remoteHead, (await repo.git('rev-parse', 'HEAD')).trim());
  });

  it('runPush push sends new commits and throws GitError on failure', async () => {
    await withOrigin();
    await commit('b.txt');
    await runPush(repo.root, { kind: 'push' }, 'main');
    assert.equal((await readPushInfo(repo.root)).ahead, 0);
    await repo.git('remote', 'set-url', 'origin', join(bare, 'missing'));
    await commit('c.txt');
    await assert.rejects(runPush(repo.root, { kind: 'push' }, 'main'), { name: 'GitError' });
  });

  it('new branch with no commits ahead and no upstream -> setUpstream', async () => {
    await withOrigin();
    await repo.git('checkout', '-b', 'fresh');
    const i = await readPushInfo(repo.root);
    assert.equal(i.upstream, undefined);
    assert.equal(i.ahead, 0);
    assert.deepEqual(decidePush(i), { kind: 'setUpstream', remote: 'origin' });
  });

  it('non-fast-forward rejection throws GitError mentioning the rejection', async () => {
    await withOrigin();
    const other = await createTempRepo();
    try {
      await other.git('remote', 'add', 'origin', bare);
      await other.git('pull', 'origin', 'main');
      other.write('x.txt', 'x\n');
      await other.git('add', '-A');
      await other.git('commit', '-m', 'x');
      await other.git('push', 'origin', 'main');
    } finally {
      await other.cleanup();
    }
    await commit('b.txt');
    await assert.rejects(runPush(repo.root, { kind: 'push' }, 'main'), (e: Error & { stderr?: string }) => {
      assert.equal(e.name, 'GitError');
      assert.match(e.stderr ?? '', /rejected|non-fast-forward|fetch first/);
      return true;
    });
  });

  it('default branch with a slash comes from origin/HEAD', async () => {
    await withOrigin();
    await repo.git('push', 'origin', 'main:feature/x');
    await repo.git('fetch', 'origin');
    await repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/feature/x');
    assert.equal((await readPushInfo(repo.root)).defaultBranch, 'feature/x');
  });

  it('without origin the first remote decides the default branch', async () => {
    await repo.git('remote', 'add', 'upstream', bare);
    await repo.git('push', 'upstream', 'main:trunk');
    await repo.git('fetch', 'upstream');
    await repo.git('symbolic-ref', 'refs/remotes/upstream/HEAD', 'refs/remotes/upstream/trunk');
    assert.equal((await readPushInfo(repo.root)).defaultBranch, 'trunk');
  });
});
