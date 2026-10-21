import * as vscode from 'vscode';
import type { API, GitExtension, Repository } from './git.d';

export type GitRepository = Repository;

async function getApi(): Promise<API | undefined> {
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
