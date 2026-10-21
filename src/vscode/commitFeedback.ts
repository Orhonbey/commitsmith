import * as vscode from 'vscode';
import { CommitResult, refreshIndex } from '../git/commitEngine';
import type { GitRepository } from './gitApi';

type Failed = NonNullable<CommitResult['failed']>;

/** Localized text for a failed commit run (Write + Commit and Smart split); git's own output goes to the log. */
export function commitFailureText(f: Failed, done: CommitResult['done']): string | undefined {
  if (f.committed) {
    const sha = done[done.length - 1]?.sha.slice(0, 7) ?? '';
    return vscode.l10n.t('Committed {0}, but refreshing the index failed. The log has details', sha);
  }
  if (f.code === 'inProgress') return vscode.l10n.t('A merge, cherry-pick, revert or rebase is in progress. Finish it first');
  if (f.code === 'emptyGroup') return vscode.l10n.t('There are no files to commit');
  if (f.code === 'cancelled') return undefined;
  return vscode.l10n.t('Commit failed. The log has details');
}

/**
 * The commit landed but the real index still holds the old entries (they show as a staged revert).
 * A modal warning offers to re-run the reset of exactly those paths until it works or the user stops.
 */
export async function offerIndexRefresh(
  root: string,
  repo: GitRepository,
  result: CommitResult,
  log: vscode.OutputChannel,
): Promise<void> {
  const f = result.failed;
  if (!f?.committed || !f.resetPaths) return;
  const retry = vscode.l10n.t('Retry index refresh');
  const detail = vscode.l10n.t('Until the index is refreshed, the committed files show as staged changes that would undo the commit.');
  while ((await vscode.window.showWarningMessage(commitFailureText(f, result.done)!, { modal: true, detail }, retry)) === retry) {
    const r = await refreshIndex(root, f.resetPaths);
    await repo.status();
    if (r.ok) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Index refreshed'));
      return;
    }
    log.appendLine(`index refresh failed: ${r.stderr}`);
  }
}
