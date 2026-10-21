import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { GitError, pathspecInput, runGit } from './gitRunner';
import type { Scope } from './scope';

export type CommitGroup = { message: string; paths: string[] };

export type CommitResult = {
  done: { sha: string; message: string }[];
  failed?: { index: number; message: string; error: string; committed?: boolean; code?: 'inProgress' | 'emptyGroup' | 'cancelled' };
};

/** Env for commands that act on the user's real index: never inherit a GIT_INDEX_FILE. */
const REAL_INDEX_ENV: NodeJS.ProcessEnv = { GIT_INDEX_FILE: undefined };

const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply'];

function describeError(e: unknown): string {
  if (e instanceof GitError) return (e.stderr.trim() || e.message).trim();
  return e instanceof Error ? e.message : String(e);
}

/**
 * Fills the temporary index with HEAD. It starts as a copy of the real index so `git read-tree -m`
 * keeps the stat data of every entry that matches HEAD; otherwise `git commit` would re-hash every
 * tracked file. Falls back to a plain `read-tree HEAD` (e.g. no real index yet, or unmerged entries).
 * Exported for tests.
 */
export async function seedTempIndex(root: string, tmp: string, hasHead: boolean): Promise<void> {
  const env = { GIT_INDEX_FILE: tmp };
  if (!hasHead) {
    await runGit(root, ['read-tree', '--empty'], { env });
    return;
  }
  try {
    const real = (await runGit(root, ['rev-parse', '--git-path', 'index'], { env: REAL_INDEX_ENV })).stdout.trim();
    await copyFile(resolve(root, real), tmp);
    await runGit(root, ['read-tree', '-m', 'HEAD'], { env });
    return;
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
  }
  await runGit(root, ['read-tree', 'HEAD'], { env });
}

/**
 * Commit each group through a temporary index so the user's real index and working tree
 * are never rebuilt. The only change to the real index is the final `git reset` of the
 * committed paths, which makes them match the new HEAD.
 */
export async function commitGroups(
  root: string,
  kind: Scope['kind'],
  groups: CommitGroup[],
  signal?: AbortSignal,
): Promise<CommitResult> {
  const done: CommitResult['done'] = [];
  const fail = (index: number, error: string, code?: NonNullable<CommitResult['failed']>['code']): CommitResult => ({
    done,
    failed: { index, message: groups[index].message, error, code },
  });

  let gitDir: string;
  try {
    gitDir = (await runGit(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  } catch (e) {
    return groups.length > 0 ? fail(0, describeError(e)) : { done };
  }

  if (groups.length > 0 && IN_PROGRESS.some((n) => existsSync(join(gitDir, n)))) {
    return fail(0, 'A merge, cherry-pick, revert or rebase is in progress — finish it first.', 'inProgress');
  }

  for (let i = 0; i < groups.length; i++) {
    if (signal?.aborted) return fail(i, 'cancelled', 'cancelled');
    const group = groups[i];
    if (group.paths.length === 0) return fail(i, 'This group has no files.', 'emptyGroup');
    const tmp = join(gitDir, `commitsmith-index-${randomBytes(8).toString('hex')}`);
    const env = { GIT_INDEX_FILE: tmp };
    const pathsInput = pathspecInput(group.paths);
    try {
      const hasHead = (await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { env: REAL_INDEX_ENV, allowFail: true })).code === 0;
      await seedTempIndex(root, tmp, hasHead);

      if (kind === 'staged') {
        const wanted = new Set(group.paths);
        const real = (await runGit(root, ['ls-files', '-s', '-z'], { env: REAL_INDEX_ENV })).stdout;
        const entries: string[] = [];
        const present = new Set<string>();
        for (const rec of real.split('\0')) {
          const tab = rec.indexOf('\t');
          if (tab < 0) continue;
          const path = rec.slice(tab + 1);
          if (!wanted.has(path)) continue;
          present.add(path);
          entries.push(rec + '\0');
        }
        if (entries.length > 0) {
          await runGit(root, ['update-index', '-z', '--index-info'], { env, input: entries.join('') });
        }
        const gone = group.paths.filter((p) => !present.has(p));
        if (gone.length > 0) {
          await runGit(root, ['update-index', '-z', '--force-remove', '--stdin'], {
            env,
            input: pathspecInput(gone),
          });
        }
      } else {
        await runGit(root, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'], {
          env,
          input: pathsInput,
        });
      }

      const commit = await runGit(root, ['commit', '-q', '-F', '-'], { env, input: group.message, allowFail: true });
      if (commit.code !== 0) {
        return fail(i, `${commit.stderr}\n${commit.stdout}`.trim() || `git commit failed (${commit.code})`);
      }
      const sha = (await runGit(root, ['rev-parse', 'HEAD'], { env: REAL_INDEX_ENV })).stdout.trim();
      done.push({ sha, message: group.message });

      // Real index: every path the commit touched (hooks may add more) now equals the new HEAD.
      const touched = (
        await runGit(root, ['diff-tree', '-r', '-z', '--name-only', '--no-commit-id', '--root', 'HEAD'], {
          env: REAL_INDEX_ENV,
        })
      ).stdout.split('\0');
      const resetPaths = [...new Set([...group.paths, ...touched.filter(Boolean)])];
      const reset = await runGit(root, ['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        env: REAL_INDEX_ENV,
        input: pathspecInput(resetPaths),
        allowFail: true,
      });
      if (reset.code !== 0) {
        const f = fail(i, `committed ${sha}, but refreshing the index failed: ${reset.stderr.trim()}`);
        f.failed!.committed = true;
        return f;
      }
    } catch (e) {
      return fail(i, describeError(e));
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
      await rm(`${tmp}.lock`, { force: true }).catch(() => {});
    }
  }
  return { done };
}
