import * as vscode from 'vscode';
import { decidePush, readPushInfo } from '../push/push';
import type { GitRepository } from './gitApi';
import type { RecentEntry } from './panelModel';

/** The git extension's errors carry git's stderr next to a generic message. */
function pushErrorText(e: unknown): string {
  const err = e as { stderr?: unknown; message?: unknown } | undefined;
  const text = typeof err?.stderr === 'string' && err.stderr.trim() ? err.stderr : String(err?.message ?? e);
  return text.trim();
}

/**
 * Push with its confirmations; shared by the Push command and Smart split's "Push when done".
 * The push itself goes through the git extension (`repo.push`), so VS Code's credential and SSH
 * prompts work. Errors are shown, not thrown.
 */
export async function pushFlow(
  root: string,
  repo: GitRepository,
  log: vscode.OutputChannel,
  record: (entry: RecentEntry) => void = () => {},
): Promise<void> {
  const info = await readPushInfo(root);
  const d = decidePush(info);
  if (d.kind === 'noRemote') {
    void vscode.window.showErrorMessage(vscode.l10n.t('This repository has no remote to push to'));
    return;
  }
  if (d.kind === 'nothing') {
    void vscode.window.showInformationMessage(
      info.branch
        ? vscode.l10n.t('Nothing to push')
        : info.unborn
          ? vscode.l10n.t('Nothing to push yet. Make a first commit')
          : vscode.l10n.t('Not on a branch'),
    );
    return;
  }
  const go = vscode.l10n.t('Push');
  if (d.kind === 'setUpstream') {
    const ok = await vscode.window.showInformationMessage(
      vscode.l10n.t('Publish branch {0} to {1}?', info.branch, d.remote),
      { modal: true },
      go,
    );
    if (ok !== go) return;
  } else if (d.confirmDefault) {
    const ok = await vscode.window.showWarningMessage(
      vscode.l10n.t('Push {0} commits to {1}?', info.ahead, info.upstream ?? info.branch),
      { modal: true },
      go,
    );
    if (ok !== go) return;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing...') },
      () => (d.kind === 'setUpstream' ? repo.push(d.remote, info.branch, true) : repo.push()),
    );
  } catch (e) {
    const text = pushErrorText(e);
    log.appendLine(`push failed: ${text}`);
    const show = vscode.l10n.t('Show log');
    const firstLine = text.split('\n').find((l) => l.trim()) ?? '';
    const failed = vscode.l10n.t('Push failed: {0}', firstLine);
    record({ kind: 'failed', text: failed });
    if ((await vscode.window.showErrorMessage(failed, show)) === show) log.show(true);
    return;
  }
  await repo.status();
  record({ kind: 'pushed', branch: info.branch });
  void vscode.window.showInformationMessage(vscode.l10n.t('Pushed {0}', info.branch));
}
