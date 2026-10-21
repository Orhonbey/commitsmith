import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Activity } from './activity';
import {
  buildChangeGroups,
  diffTarget,
  type ChangeGroup,
  type ChangeKind,
  type FileItem,
  type GroupId,
  type RawChange,
  type Side,
} from './changesModel';
import { getApi, RepoWatcher, type GitRepository } from './gitApi';
import type { Change } from './git.d';
import type { RepoSelection } from './repoSelection';

export const CHANGES_VIEW_ID = 'commitsmith.changes';

export type GroupNode = { type: 'group'; root: string; id: GroupId; count: number; leftOut: boolean };
export type FileNode = { type: 'file'; root: string; item: FileItem };
export type MoreNode = { type: 'more'; count: number };
export type ChangeNode = GroupNode | FileNode | MoreNode;

type Loaded = { root: string; repo: GitRepository; groups: ChangeGroup[] };

const toRaw = (root: string, c: Change): RawChange => {
  const rel = (p: vscode.Uri) => path.relative(root, p.fsPath).split(path.sep).join('/');
  const orig = c.renameUri ? rel(c.originalUri) : undefined;
  return { path: rel(c.uri), ...(orig ? { origPath: orig } : {}), status: c.status as number };
};

function statusWord(kind: ChangeKind): string {
  switch (kind) {
    case 'modified':
      return vscode.l10n.t('Modified');
    case 'added':
      return vscode.l10n.t('Added');
    case 'deleted':
      return vscode.l10n.t('Deleted');
    case 'renamed':
      return vscode.l10n.t('Renamed');
    case 'copied':
      return vscode.l10n.t('Copied');
    case 'untracked':
      return vscode.l10n.t('New file');
    case 'typeChanged':
      return vscode.l10n.t('Type changed');
    default:
      return vscode.l10n.t('Conflict');
  }
}

function groupLabel(id: GroupId, count: number): string {
  if (id === 'merge') return vscode.l10n.t('Merge Changes ({0})', count);
  if (id === 'staged') return vscode.l10n.t('Staged Changes ({0})', count);
  if (id === 'changes') return vscode.l10n.t('Changes ({0})', count);
  return vscode.l10n.t('New Files ({0})', count);
}

/** The repository's staged / changed / new files as a native tree that looks like Source Control. */
export class ChangesView implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<ChangeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private loaded: Loaded | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Bumped on every refresh, so a load that started before it cannot cache stale data. */
  private generation = 0;
  private readonly subs: vscode.Disposable[] = [];
  private readonly watcher: RepoWatcher;

  constructor(
    private readonly selection: RepoSelection,
    private readonly activity: Activity,
  ) {
    this.watcher = new RepoWatcher(() => this.refresh());
    this.subs.push(
      this.emitter,
      selection.onDidChange(() => this.refresh(0)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('commitsmith.includeUntracked')) this.refresh(0);
      }),
    );
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.watcher.dispose();
    for (const s of this.subs) s.dispose();
  }

  /** Re-reads the git extension's state shortly (a burst of file events becomes one refresh). */
  refresh(delay = 150): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.generation++;
      this.loaded = undefined;
      this.emitter.fire(undefined);
    }, delay);
  }

  /** The groups of the selected repository, straight from the git extension (no `git status` process). */
  async load(): Promise<Loaded | undefined> {
    const api = await getApi();
    const repos = api?.repositories ?? [];
    const root = this.selection.resolve(repos.map((r) => r.rootUri.fsPath));
    const repo = repos.find((r) => r.rootUri.fsPath === root);
    if (!root || !repo) return undefined;
    const st = repo.state;
    const raw = (list: readonly Change[] | undefined) => (list ?? []).map((c) => toRaw(root, c));
    return {
      root,
      repo,
      groups: buildChangeGroups({
        merge: raw(st.mergeChanges),
        index: raw(st.indexChanges),
        working: raw(st.workingTreeChanges),
        untracked: raw(st.untrackedChanges),
        includeUntracked: vscode.workspace.getConfiguration('commitsmith').get<boolean>('includeUntracked', false),
      }),
    };
  }

  private async current(): Promise<Loaded | undefined> {
    if (this.loaded) return this.loaded;
    const gen = this.generation;
    const fresh = await this.load();
    if (gen === this.generation) this.loaded = fresh;
    return fresh;
  }

  async getChildren(node?: ChangeNode): Promise<ChangeNode[]> {
    const cur = await this.current();
    if (!cur) return [];
    if (!node) return cur.groups.map((g) => ({ type: 'group', root: cur.root, id: g.id, count: g.count, leftOut: g.leftOut }));
    if (node.type !== 'group') return [];
    const group = cur.groups.find((g) => g.id === node.id);
    return (group?.items ?? []).map((i) => (i.kind === 'file' ? { type: 'file', root: cur.root, item: i } : { type: 'more', count: i.count }));
  }

  getTreeItem(node: ChangeNode): vscode.TreeItem {
    if (node.type === 'group') {
      const t = new vscode.TreeItem(groupLabel(node.id, node.count), vscode.TreeItemCollapsibleState.Expanded);
      t.id = `${node.root}|${node.id}`;
      t.contextValue = `group.${node.id}`;
      if (node.leftOut) t.description = vscode.l10n.t('not included in Write + Commit');
      return t;
    }
    if (node.type === 'more') {
      const t = new vscode.TreeItem(vscode.l10n.t('… {0} more files', node.count), vscode.TreeItemCollapsibleState.None);
      t.contextValue = 'more';
      return t;
    }
    const f = node.item;
    const t = new vscode.TreeItem(f.name, vscode.TreeItemCollapsibleState.None);
    t.id = `${node.root}|${f.group}|${f.path}`;
    t.resourceUri = vscode.Uri.file(path.join(node.root, f.path));
    t.description = f.dir;
    t.tooltip = `${f.origPath ? `${f.origPath} → ` : ''}${f.path}\n${statusWord(f.change)}`;
    t.contextValue = f.group === 'merge' ? 'file.merge' : f.group === 'staged' ? 'file.staged' : f.group === 'changes' ? 'file.changes' : 'file.new';
    t.command = { command: 'commitsmith.openChange', title: '', arguments: [node] };
    return t;
  }

  // ---- actions (registered in extension.ts) ----

  private async repoFor(root: unknown): Promise<GitRepository | undefined> {
    if (typeof root !== 'string') return undefined;
    return (await getApi())?.repositories.find((r) => r.rootUri.fsPath === root);
  }

  /** Accepts only well-formed file nodes of an open repository whose path stays inside it. */
  private async files(node: unknown, nodes: unknown): Promise<{ repo: GitRepository; root: string; items: FileItem[] } | undefined> {
    const list = (Array.isArray(nodes) && nodes.length > 0 ? nodes : [node]) as Partial<FileNode>[];
    const first = list.find((n) => n?.type === 'file');
    const repo = await this.repoFor(first?.root);
    if (!first || !repo) return undefined;
    const root = repo.rootUri.fsPath;
    const items = list
      .filter((n): n is FileNode => n?.type === 'file' && n.root === root && typeof n.item?.path === 'string' && this.inside(root, n.item.path) && (n.item.origPath === undefined || (typeof n.item.origPath === 'string' && this.inside(root, n.item.origPath))))
      .map((n) => n.item);
    return items.length > 0 ? { repo, root, items } : undefined;
  }

  private inside(root: string, rel: string): boolean {
    const abs = path.resolve(root, rel);
    return abs === root || abs.startsWith(root + path.sep);
  }

  private abs(root: string, paths: readonly string[]): string[] {
    return paths.map((p) => path.join(root, p));
  }

  private async groupOf(node: unknown): Promise<{ repo: GitRepository; root: string; group: ChangeGroup } | undefined> {
    const n = node as Partial<GroupNode> | undefined;
    if (n?.type !== 'group') return undefined;
    const repo = await this.repoFor(n.root);
    if (!repo) return undefined;
    const cur = await this.load();
    const group = cur?.root === repo.rootUri.fsPath ? cur.groups.find((g) => g.id === n.id) : undefined;
    return group ? { repo, root: repo.rootUri.fsPath, group } : undefined;
  }

  /** The index is written by CommitSmith jobs too; do not interleave with a running one. */
  private free(root: string): boolean {
    if (!this.activity.isBusy(root)) return true;
    void vscode.window.showInformationMessage(vscode.l10n.t('CommitSmith is already working on this repository'));
    return false;
  }

  /** Items plus their old rename paths: unstaging only the new path would leave the old path's deletion staged. */
  private withOrig(items: FileItem[]): string[] {
    return [...new Set(items.flatMap((i) => (i.origPath ? [i.path, i.origPath] : [i.path])))];
  }

  stage = async (node?: unknown, nodes?: unknown): Promise<void> => {
    const f = await this.files(node, nodes);
    if (!f || !this.free(f.root)) return;
    // Staging a conflicted file marks it resolved: ask first. The state is re-read, not taken from the node.
    const cur = await this.load();
    const conflicted = new Set(cur?.root === f.root ? cur.groups.find((g) => g.id === 'merge')?.paths : []);
    const marked = f.items.filter((i) => conflicted.has(i.path));
    if (marked.length > 0) {
      const text = marked.length === 1
        ? vscode.l10n.t('Mark {0} as resolved?', marked[0].name)
        : vscode.l10n.t('Mark {0} files as resolved?', marked.length);
      const yes = vscode.l10n.t('Mark as resolved');
      if ((await vscode.window.showWarningMessage(text, { modal: true }, yes)) !== yes) return;
    }
    await f.repo.add(this.abs(f.root, f.items.map((i) => i.path)));
  };

  unstage = async (node?: unknown, nodes?: unknown): Promise<void> => {
    const f = await this.files(node, nodes);
    if (f && this.free(f.root)) await f.repo.revert(this.abs(f.root, this.withOrig(f.items)));
  };

  /** Asks first, always; restores tracked files only. What may be restored is re-read from the repository, not from the node. */
  discard = async (node?: unknown, nodes?: unknown): Promise<void> => {
    const f = await this.files(node, nodes);
    if (!f || !this.free(f.root)) return;
    const cur = await this.load();
    const allowed = new Set(cur?.root === f.root ? cur.groups.find((g) => g.id === 'changes')?.discardPaths : []);
    const items = f.items.filter((i) => allowed.has(i.path));
    if (items.length === 0) return;
    const text = items.length === 1
      ? vscode.l10n.t('Discard changes in {0}? This cannot be undone.', items[0].name)
      : vscode.l10n.t('Discard changes in {0} files? This cannot be undone.', items.length);
    await this.confirmedClean(f.repo, f.root, items.map((i) => i.path), text);
  };

  stageAll = async (node?: unknown): Promise<void> => {
    const g = await this.groupOf(node);
    if (g && (g.group.id === 'changes' || g.group.id === 'untracked') && this.free(g.root)) await g.repo.add(this.abs(g.root, g.group.paths));
  };

  unstageAll = async (node?: unknown): Promise<void> => {
    const g = await this.groupOf(node);
    if (g && g.group.id === 'staged' && this.free(g.root)) await g.repo.revert(this.abs(g.root, g.group.paths)); // a staged group's paths include old rename paths
  };

  discardAll = async (node?: unknown): Promise<void> => {
    const g = await this.groupOf(node);
    if (!g || g.group.id !== 'changes' || !this.free(g.root)) return;
    if (g.group.discardPaths.length === 0) return;
    await this.confirmedClean(g.repo, g.root, g.group.discardPaths, vscode.l10n.t('Discard all {0} changes? This cannot be undone.', g.group.discardPaths.length));
  };

  private async confirmedClean(repo: GitRepository, root: string, paths: string[], text: string): Promise<void> {
    const discard = vscode.l10n.t('Discard');
    const picked = await vscode.window.showWarningMessage(text, { modal: true }, discard);
    if (picked !== discard) return;
    await repo.clean(this.abs(root, paths));
  }

  openFile = async (node?: unknown, nodes?: unknown): Promise<void> => {
    const f = await this.files(node, nodes);
    if (!f) return;
    for (const i of f.items) {
      try {
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(f.root, i.path)));
      } catch {
        // A deleted file has nothing to open.
      }
    }
  };

  copyPath = async (node?: unknown, nodes?: unknown): Promise<void> => {
    const f = await this.files(node, nodes);
    if (f) await vscode.env.clipboard.writeText(f.items.map((i) => i.path).join('\n'));
  };

  /** Opens what Source Control would open for this file. */
  openChange = async (node?: unknown): Promise<void> => {
    const f = await this.files(node, undefined);
    const api = await getApi();
    if (!f || !api) return;
    const [item] = f.items;
    const uri = (s: Side) => {
      const file = vscode.Uri.file(path.join(f.root, s.path));
      return s.ref === 'worktree' ? file : api.toGitUri(file, s.ref);
    };
    const target = diffTarget(item);
    try {
      if (target.kind === 'diff') {
        const title = target.title === 'headToIndex'
          ? vscode.l10n.t('{0} (HEAD ↔ Index)', item.name)
          : vscode.l10n.t('{0} (Index ↔ Working Tree)', item.name);
        await vscode.commands.executeCommand('vscode.diff', uri(target.left), uri(target.right), title);
      } else {
        const title = target.title === 'head'
          ? vscode.l10n.t('{0} (HEAD)', item.name)
          : target.title === 'index'
            ? vscode.l10n.t('{0} (Index)', item.name)
            : item.name;
        await vscode.commands.executeCommand('vscode.open', uri(target.side), { preview: true }, title);
      }
    } catch {
      // The file changed or vanished between click and open; the tree refreshes on its own.
    }
  };

  /** Extension tests only: the current tree as plain nodes, so tests can drive the commands. */
  async testHook(): Promise<{ group: GroupNode; children: ChangeNode[] }[]> {
    this.loaded = undefined;
    const tops = (await this.getChildren()) as GroupNode[];
    return Promise.all(tops.map(async (group) => ({ group, children: await this.getChildren(group) })));
  }
}
