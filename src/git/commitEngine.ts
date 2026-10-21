import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { GitError, pathspecInput, runGit } from './gitRunner';
import type { Scope } from './scope';

export type CommitGroup = { message: string; paths: string[] };

export type CommitResult = {
  done: { sha: string; message: string }[];
  failed?: { index: number; message: string; error: string };
};

function describeError(e: unknown): string {
  if (e instanceof GitError) return (e.stderr.trim() || e.message).trim();
  return e instanceof Error ? e.message : String(e);
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
  const fail = (index: number, error: string): CommitResult => ({
    done,
    failed: { index, message: groups[index].message, error },
  });

  let gitDir: string;
  try {
    gitDir = (await runGit(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
  } catch (e) {
    return groups.length > 0 ? fail(0, describeError(e)) : { done };
  }

  for (let i = 0; i < groups.length; i++) {
    if (signal?.aborted) return fail(i, 'cancelled');
    const group = groups[i];
    const tmp = join(gitDir, `commitsmith-index-${randomBytes(8).toString('hex')}`);
    const env = { GIT_INDEX_FILE: tmp };
    const pathsInput = pathspecInput(group.paths);
    try {
      const hasHead = (await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { allowFail: true })).code === 0;
      await runGit(root, hasHead ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env });

      if (kind === 'staged') {
        const wanted = new Set(group.paths);
        const real = (await runGit(root, ['ls-files', '-s', '-z'])).stdout;
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
      const sha = (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
      done.push({ sha, message: group.message });

      // Real index: committed paths now equal the new HEAD. Nothing else is touched.
      const reset = await runGit(root, ['reset', '-q', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        input: pathsInput,
        allowFail: true,
      });
      if (reset.code !== 0) {
        return fail(i, `committed ${sha}, but refreshing the index failed: ${reset.stderr.trim()}`);
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
