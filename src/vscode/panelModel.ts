// Pure view-model of the Activity Bar panel's webview: turns status, push info and picker state
// into plain JSON. The file list and the Recent list are native trees (changesModel, recentView). No vscode import, so it is unit-tested with mocha.
import { resolveScope } from '../git/scope';
import type { FileStatus } from '../git/status';
import { decidePush, type PushInfo } from '../push/push';

export const RECENT_MAX = 5;

export type RecentEntry =
  | { kind: 'committed'; sha: string; subject: string }
  | { kind: 'pushed'; branch: string }
  | { kind: 'failed'; text: string };

/** Newest first, capped at RECENT_MAX. Returns a new list. */
export function addRecent(list: readonly RecentEntry[], entry: RecentEntry): RecentEntry[] {
  return [entry, ...list].slice(0, RECENT_MAX);
}

export type PushLine =
  | { kind: 'unknown' }
  | { kind: 'noRemote' }
  | { kind: 'unborn' }
  | { kind: 'detached' }
  | { kind: 'noUpstream'; branch: string; ahead: number }
  | { kind: 'upstream'; branch: string; upstream: string; ahead: number };

export type AiRow = {
  /** "Claude Code · Haiku" when a tool can run; otherwise `problem` says why not. */
  current?: string;
  problem?: { kind: 'missing' | 'noModels'; name: string } | { kind: 'none' };
  tools: { name: string; found: boolean }[];
};

export type PanelInput = {
  ai: AiRow;
  repos: string[];
  selected: string | undefined;
  status: FileStatus[];
  includeUntracked: boolean;
  push: PushInfo | undefined;
  busy: boolean;
  /** The commit message currently in the repository's Source Control input box. */
  message: string;
};

export type PanelModel = {
  hasRepo: boolean;
  ai: AiRow;
  repo: { name: string; selected: string; choices: { root: string; name: string }[] };
  scope: { staged: number; all: number; active: 'staged' | 'all' };
  push: PushLine;
  busy: boolean;
  message: string;
};

const folderName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() || root;

function pushLine(info: PushInfo | undefined): PushLine {
  if (!info) return { kind: 'unknown' };
  const d = decidePush(info);
  if (d.kind === 'noRemote') return { kind: 'noRemote' };
  if (!info.branch) return { kind: info.unborn ? 'unborn' : 'detached' };
  if (!info.upstream) return { kind: 'noUpstream', branch: info.branch, ahead: info.ahead };
  return { kind: 'upstream', branch: info.branch, upstream: info.upstream, ahead: info.ahead };
}

export function buildPanelModel(i: PanelInput): PanelModel {
  const selected = i.selected && i.repos.includes(i.selected) ? i.selected : i.repos[0] ?? '';
  // Same rule as the commands: staged wins, else everything. "All" is what would be used if nothing were staged.
  const real = resolveScope(i.status, { includeUntracked: i.includeUntracked });
  const unstaged = resolveScope(
    i.status.map((s) => ({ ...s, index: '.' as const })),
    { includeUntracked: i.includeUntracked },
  );
  const staged = real.kind === 'staged' ? real.files.length : 0;
  return {
    hasRepo: i.repos.length > 0,
    ai: i.ai,
    repo: {
      name: folderName(selected),
      selected,
      choices: i.repos.length > 1 ? i.repos.map((root) => ({ root, name: folderName(root) })) : [],
    },
    scope: {
      staged,
      all: unstaged.files.length,
      active: staged > 0 ? 'staged' : 'all',
    },
    push: pushLine(i.push),
    busy: i.busy,
    message: i.message,
  };
}
