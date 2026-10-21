import * as vscode from 'vscode';
import type { API, GitExtension, Repository } from './git.d';

export type GitRepository = Repository;

export async function getApi(): Promise<API | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return undefined;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  if (!exports.enabled) return undefined;
  return exports.getAPI(1);
}

/**
 * Finds the repository a command was invoked for. `arg` is the SourceControl passed by an
 * `scm/title` command (it has `rootUri`); otherwise the only repository, else a quick pick.
 */
export async function getRepository(arg: unknown): Promise<{ root: string; repo: GitRepository } | undefined> {
  const api = await getApi();
  const repos = api?.repositories ?? [];
  if (repos.length === 0) {
    void vscode.window.showErrorMessage(vscode.l10n.t('No Git repository is open'));
    return undefined;
  }
  const rootUri = (arg as { rootUri?: vscode.Uri } | undefined)?.rootUri;
  let repo: Repository | undefined;
  if (rootUri) repo = repos.find((r) => r.rootUri.fsPath === rootUri.fsPath);
  if (!repo && repos.length === 1) repo = repos[0];
  if (!repo) {
    const picked = await vscode.window.showQuickPick(
      repos.map((r) => ({ label: r.rootUri.fsPath.split(/[\\/]/).pop() || r.rootUri.fsPath, description: r.rootUri.fsPath, repo: r })),
      { placeHolder: vscode.l10n.t('Choose a repository') },
    );
    repo = picked?.repo;
  }
  return repo ? { root: repo.rootUri.fsPath, repo } : undefined;
}

/** Calls `onChange` whenever a repository opens, closes or changes state. */
export class RepoWatcher implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  private readonly repoSubs = new Map<string, vscode.Disposable>();
  private disposed = false;

  constructor(private readonly onChange: () => void) {
    void this.start();
  }

  private async start(): Promise<void> {
    const api = await getApi();
    if (!api || this.disposed) return;
    const sync = () => {
      const open = new Map(api.repositories.map((r) => [r.rootUri.fsPath, r]));
      for (const [root, sub] of this.repoSubs) {
        if (!open.has(root)) {
          sub.dispose();
          this.repoSubs.delete(root);
        }
      }
      for (const [root, repo] of open) {
        if (!this.repoSubs.has(root)) this.repoSubs.set(root, repo.state.onDidChange(() => this.onChange()));
      }
      this.onChange();
    };
    this.subs.push(api.onDidOpenRepository(sync), api.onDidCloseRepository(sync));
    sync();
  }

  dispose(): void {
    this.disposed = true;
    for (const s of [...this.subs, ...this.repoSubs.values()]) s.dispose();
  }
}
