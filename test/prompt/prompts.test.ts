import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileDiff } from '../../src/git/diffCollector';
import { buildMessagePrompt, buildSplitPrompt, SPLIT_SCHEMA } from '../../src/prompt/prompts';
import { readRepoContext, type RepoContext } from '../../src/prompt/repoContext';
import { createTempRepo } from '../helpers/tempRepo';

const fd = (o: Partial<FileDiff>): FileDiff => ({
  path: 'a.txt', change: 'modified', isNew: false, binary: false, sizeBytes: 10, added: 1, removed: 0, summarized: false, ...o,
});
const ctx: RepoContext = {
  branch: 'main',
  recentSubjects: ['fix(drag): x'],
  rules: [{ file: 'CLAUDE.md', text: 'NEVER add Claude' }],
};

describe('prompts', () => {
  it('message prompt lists summarized file without patch', () => {
    const p = buildMessagePrompt(ctx, [fd({ path: 'Big.asset', sizeBytes: 123456, summarized: true, patch: undefined }), fd({ path: 'b.ts', patch: 'PATCHBODY' })], 'English');
    assert.ok(p.includes('Big.asset') && p.includes('123456'));
    assert.ok(p.includes('PATCHBODY'));
    const q = buildMessagePrompt(ctx, [fd({ path: 'Big.asset', sizeBytes: 123456, summarized: true, patch: 'SECRETPATCH' })], 'English');
    assert.ok(!q.includes('SECRETPATCH'));
  });

  it('prompt contains rules and subjects', () => {
    for (const p of [buildMessagePrompt(ctx, [fd({})], 'Turkish'), buildSplitPrompt(ctx, [fd({})], 'Turkish')]) {
      assert.ok(p.includes('NEVER add Claude'));
      assert.ok(p.includes('fix(drag): x'));
      assert.ok(p.includes('Turkish'));
    }
  });

  it('split prompt handles locks and renames', () => {
    const p = buildSplitPrompt(ctx, [fd({ path: 'locked.ts' }), fd({ path: 'new.ts', origPath: 'old.ts', change: 'renamed' }), fd({ path: 'free.ts', isNew: true })], 'English', {
      groups: [{ message: 'feat: locked msg', files: ['locked.ts'] }],
    });
    assert.ok(p.includes('feat: locked msg'));
    assert.ok(p.includes('old.ts -> new.ts'));
    assert.ok(p.includes('uncertain'));
    const free = p.split('Files you may group')[1] ?? '';
    assert.ok(free.includes('free.ts') && !free.includes('locked.ts'));
    assert.equal(SPLIT_SCHEMA.additionalProperties, false);
  });

  it('readRepoContext truncates rules', async () => {
    const repo = await createTempRepo();
    try {
      writeFileSync(join(repo.root, 'CLAUDE.md'), 'x'.repeat(20000));
      writeFileSync(join(repo.root, 'AGENTS.md'), 'y'.repeat(20000));
      writeFileSync(join(repo.root, 'CONTRIBUTING.md'), 'z'.repeat(20000));
      const c = await readRepoContext(repo.root);
      assert.equal(c.branch, 'main');
      assert.deepEqual(c.recentSubjects, []);
      assert.ok(c.rules[0].text.length <= 8000);
      assert.equal(c.rules.reduce((s, r) => s + r.text.length, 0), 16000);
      assert.equal(c.rules.length, 2);
    } finally {
      await repo.cleanup();
    }
  });
});
