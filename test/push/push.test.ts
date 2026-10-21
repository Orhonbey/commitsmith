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
});
