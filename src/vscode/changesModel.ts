// Pure model of the "Changes" tree: maps the git extension's change lists to groups and file items.
// No vscode import, so it is unit-tested with mocha. The tree provider only renders what this returns.

/** Numbers of the git extension's `Status` enum (src/vscode/git.d.ts), which is a const enum we cannot import. */
export const CHANGE_STATUS = {
  INDEX_MODIFIED: 0,
  INDEX_ADDED: 1,
  INDEX_DELETED: 2,
  INDEX_RENAMED: 3,
  INDEX_COPIED: 4,
  MODIFIED: 5,
  DELETED: 6,
  UNTRACKED: 7,
  IGNORED: 8,
  INTENT_TO_ADD: 9,
  INTENT_TO_RENAME: 10,
  TYPE_CHANGED: 11,
  ADDED_BY_US: 12,
  ADDED_BY_THEM: 13,
  DELETED_BY_US: 14,
  DELETED_BY_THEM: 15,
  BOTH_ADDED: 16,
  BOTH_DELETED: 17,
  BOTH_MODIFIED: 18,
} as const;

/** A group shows at most this many files, then one "… n more files" item. */
export const MAX_ITEMS_PER_GROUP = 500;

export type GroupId = 'staged' | 'changes' | 'untracked';
export type ChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'typeChanged' | 'conflict';

/** One entry of the git extension's change lists; paths are relative to the repository root, with `/`. */
export type RawChange = { path: string; origPath?: string; status: number };

export type FileItem = {
  kind: 'file';
  group: GroupId;
  path: string;
  origPath?: string;
  name: string;
  /** Folder of the file, relative to the repository root ('' at the top level). */
  dir: string;
  letter: string;
  change: ChangeKind;
  canDiscard: boolean;
};
export type MoreItem = { kind: 'more'; count: number };

export type ChangeGroup = {
  id: GroupId;
  /** All files in the group, also those past the cap. */
  count: number;
  /** Every path of the group (for Stage all / Unstage all / Discard all). */
  paths: string[];
  /** New files only: they are not part of Write + Commit. */
  leftOut: boolean;
  items: (FileItem | MoreItem)[];
};

export type ChangesInput = {
  index: readonly RawChange[];
  working: readonly RawChange[];
  untracked: readonly RawChange[];
  includeUntracked: boolean;
};

const C = CHANGE_STATUS;
const KIND: Record<number, ChangeKind | undefined> = {
  [C.INDEX_MODIFIED]: 'modified',
  [C.INDEX_ADDED]: 'added',
  [C.INDEX_DELETED]: 'deleted',
  [C.INDEX_RENAMED]: 'renamed',
  [C.INDEX_COPIED]: 'copied',
  [C.MODIFIED]: 'modified',
  [C.DELETED]: 'deleted',
  [C.UNTRACKED]: 'untracked',
  [C.INTENT_TO_ADD]: 'added',
  [C.INTENT_TO_RENAME]: 'renamed',
  [C.TYPE_CHANGED]: 'typeChanged',
  [C.ADDED_BY_US]: 'conflict',
  [C.ADDED_BY_THEM]: 'conflict',
  [C.DELETED_BY_US]: 'conflict',
  [C.DELETED_BY_THEM]: 'conflict',
  [C.BOTH_ADDED]: 'conflict',
  [C.BOTH_DELETED]: 'conflict',
  [C.BOTH_MODIFIED]: 'conflict',
};
const LETTER: Record<ChangeKind, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  typeChanged: 'T',
  conflict: '!',
};

function toItem(group: GroupId, r: RawChange, change: ChangeKind): FileItem {
  const slash = r.path.lastIndexOf('/');
  return {
    kind: 'file',
    group,
    path: r.path,
    ...(r.origPath ? { origPath: r.origPath } : {}),
    name: r.path.slice(slash + 1),
    dir: slash < 0 ? '' : r.path.slice(0, slash),
    letter: LETTER[change],
    change,
    // Discard restores tracked files; a new file would be deleted, so it never offers it.
    canDiscard: group === 'changes',
  };
}

function makeGroup(id: GroupId, raw: readonly RawChange[], leftOut: boolean): ChangeGroup | undefined {
  const items: FileItem[] = [];
  for (const r of raw) {
    const change = KIND[r.status];
    if (change) items.push(toItem(id, r, change));
  }
  if (items.length === 0) return undefined;
  items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const shown: (FileItem | MoreItem)[] = items.slice(0, MAX_ITEMS_PER_GROUP);
  if (items.length > MAX_ITEMS_PER_GROUP) shown.push({ kind: 'more', count: items.length - MAX_ITEMS_PER_GROUP });
  return { id, count: items.length, paths: items.map((i) => i.path), leftOut, items: shown };
}

/** Staged, Changes and New Files; empty groups are left out. */
export function buildChangeGroups(i: ChangesInput): ChangeGroup[] {
  // The API lists new files in `untrackedChanges` when it can, otherwise inside `workingTreeChanges`.
  const isNew = (r: RawChange) => r.status === C.UNTRACKED;
  const fresh = new Map<string, RawChange>();
  for (const r of [...i.untracked, ...i.working.filter(isNew)]) fresh.set(r.path, r);
  const staged = makeGroup('staged', i.index, false);
  const changes = makeGroup('changes', i.working.filter((r) => !isNew(r)), false);
  const untracked = makeGroup('untracked', [...fresh.values()], !i.includeUntracked && !staged);
  return [staged, changes, untracked].filter((g): g is ChangeGroup => !!g);
}

/** Where a file side lives: HEAD, the index (''), or the file on disk. */
export type Side = { ref: 'HEAD' | '' | 'worktree'; path: string };
export type OpenTarget =
  | { kind: 'diff'; title: 'headToIndex' | 'indexToWorktree'; left: Side; right: Side }
  | { kind: 'open'; title: 'file' | 'head' | 'index'; side: Side };

/** What a click on a file opens, matching the Source Control view. */
export function diffTarget(f: FileItem): OpenTarget {
  const here = f.path;
  if (f.group === 'untracked') return { kind: 'open', title: 'file', side: { ref: 'worktree', path: here } };
  if (f.group === 'staged') {
    if (f.change === 'deleted') return { kind: 'open', title: 'head', side: { ref: 'HEAD', path: here } };
    if (f.change === 'added') return { kind: 'open', title: 'index', side: { ref: '', path: here } };
    return {
      kind: 'diff',
      title: 'headToIndex',
      left: { ref: 'HEAD', path: f.origPath ?? here },
      right: { ref: '', path: here },
    };
  }
  if (f.change === 'deleted') return { kind: 'open', title: 'index', side: { ref: '', path: here } };
  return {
    kind: 'diff',
    title: 'indexToWorktree',
    left: { ref: '', path: here },
    right: { ref: 'worktree', path: here },
  };
}
