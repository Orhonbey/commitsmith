import assert from 'node:assert/strict';
import { readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { collectDiff, DEFAULT_DIFF_OPTIONS } from '../../src/git/diffCollector';
import { runGit } from '../../src/git/gitRunner';
import { resolveScope } from '../../src/git/scope';
import { readStatus } from '../../src/git/status';
import { readRepoContext } from '../../src/prompt/repoContext';
import { createTempRepo, type TempRepo } from '../helpers/tempRepo';

describe('gitRunner', () => {
  let repo: TempRepo;
  beforeEach(async () => {
    repo = await createTempRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  });
  afterEach(async () => {
    await repo.cleanup();
  });

  const envOf = async (name: string, opts: Parameters<typeof runGit>[2] = {}) =>
    (await runGit(repo.root, ['-c', `alias.envtest=!echo "[$${name}]"`, 'envtest'], opts)).stdout.trim();

  it('readOnly commands run with GIT_OPTIONAL_LOCKS=0; others do not', async () => {
    assert.equal(await envOf('GIT_OPTIONAL_LOCKS', { readOnly: true }), '[0]');
    assert.equal(await envOf('GIT_OPTIONAL_LOCKS', { env: { GIT_OPTIONAL_LOCKS: undefined } }), '[]');
  });

  it('reading status, diff and context never rewrites the real index (no index.lock contention)', async () => {
    repo.write('a.txt', 'a2\n');
    // Stat-dirty but unchanged: a plain `git status` would refresh and rewrite the index.
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(repo.root, 'b.txt'), later, later);
    const index = join(repo.root, '.git', 'index');
    const before = readFileSync(index);
    const scope = resolveScope(await readStatus(repo.root), { includeUntracked: true });
    await collectDiff(repo.root, scope, DEFAULT_DIFF_OPTIONS);
    await readRepoContext(repo.root);
    assert.ok(readFileSync(index).equals(before), 'the index file was rewritten');
  });
});
