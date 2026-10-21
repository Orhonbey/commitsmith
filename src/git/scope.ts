import type { FileStatus, StatusCode } from './status';

export type ScopedFile = {
  path: string;
  origPath?: string;
  change: 'added' | 'modified' | 'deleted' | 'renamed';
  isNew: boolean;
};

export type Scope = {
  kind: 'staged' | 'all';
  files: ScopedFile[];
  leftOutUntracked: string[];
};

function changeOf(code: StatusCode): ScopedFile['change'] {
  switch (code) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    default:
      return 'modified';
  }
}

/** Staged files win; otherwise all changes. Untracked files only when includeUntracked. */
export function resolveScope(status: FileStatus[], opts: { includeUntracked: boolean }): Scope {
  const staged = status.filter((s) => !s.untracked && s.index !== '.');
  if (staged.length > 0) {
    return {
      kind: 'staged',
      files: staged.map((s) => ({
        path: s.path,
        origPath: s.origPath,
        change: changeOf(s.index),
        isNew: s.index === 'A',
      })),
      leftOutUntracked: [],
    };
  }

  const files: ScopedFile[] = [];
  const leftOut: string[] = [];
  for (const s of status) {
    if (s.untracked) {
      if (opts.includeUntracked) files.push({ path: s.path, change: 'added', isNew: true });
      else leftOut.push(s.path);
    } else if (s.worktree !== '.') {
      files.push({ path: s.path, origPath: s.origPath, change: changeOf(s.worktree), isNew: false });
    }
  }
  return { kind: 'all', files, leftOutUntracked: leftOut };
}

/**
 * What Write message / Write + Commit do with a scope: describe it, offer the new files that were
 * left out (Stage them / Smart split) when they are the only changes, or report nothing to do.
 */
export function scopeAction(scope: Scope): 'describe' | 'offerNewFiles' | 'nothing' {
  if (scope.files.length > 0) return 'describe';
  return scope.leftOutUntracked.length > 0 ? 'offerNewFiles' : 'nothing';
}
