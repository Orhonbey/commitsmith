import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { CommitResult } from '../git/commitEngine';
import type { SplitPlan } from '../split/plan';

/** Extension -> webview messages. */
export type ToWebview =
  | { type: 'plan'; plan: SplitPlan; toolLabel: string; fileCount: number; branch: string; newFiles: string[]; stale: boolean; used: boolean; revision: number; strings: Record<string, string> }
  | { type: 'busy'; text: string }
  | { type: 'result'; result: CommitResult }
  | { type: 'error'; text: string };

/** Every string the webview shows, localized here so media/plan.js holds no literals. */
export function webviewStrings(): Record<string, string> {
  return {
    proposes: vscode.l10n.t('{0} proposes {1} commits'),
    subline: vscode.l10n.t('{0} changed files · {1}'),
    new: vscode.l10n.t('new'),
    commitChecked: vscode.l10n.t('Commit checked ({0})'),
    regroup: vscode.l10n.t('Regroup'),
    cancel: vscode.l10n.t('Cancel'),
    close: vscode.l10n.t('Close'),
    pushWhenDone: vscode.l10n.t('Push when done'),
    unassigned: vscode.l10n.t('Unassigned'),
    unassignedNote: vscode.l10n.t('These files will not be committed'),
    uncertain: vscode.l10n.t('The AI is not sure about this group, so it is left unchecked'),
    hint: vscode.l10n.t('Drag a file onto another commit to move it. Use the arrows to change the commit order'),
    stale: vscode.l10n.t('Changes changed since this plan — Regroup before committing'),
    include: vscode.l10n.t('Include this commit'),
    messageLabel: vscode.l10n.t('Commit message'),
    moveUp: vscode.l10n.t('Move up'),
    moveDown: vscode.l10n.t('Move down'),
    noFiles: vscode.l10n.t('No files'),
    noGroups: vscode.l10n.t('The AI proposed no commits'),
    resultTitle: vscode.l10n.t('Commits created'),
    failed: vscode.l10n.t('Stopped at: {0}'),
  };
}

export class PlanPanel implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly onMessage: (raw: unknown) => void,
    onDispose: () => void,
  ) {
    const media = vscode.Uri.joinPath(extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'commitsmith.plan',
      vscode.l10n.t('✦ Commit plan'),
      vscode.ViewColumn.Active,
      // The plan the user is editing must survive the tab being hidden.
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
    );
    this.panel.webview.html = this.html(media);
    this.panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m));
    this.panel.onDidDispose(onDispose);
  }

  private html(media: vscode.Uri): string {
    const web = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const css = web.asWebviewUri(vscode.Uri.joinPath(media, 'plan.css'));
    const js = web.asWebviewUri(vscode.Uri.joinPath(media, 'plan.js'));
    const csp = `default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>CommitSmith</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  post(msg: ToWebview): void {
    try {
      void this.panel.webview.postMessage(msg);
    } catch {
      // The tab was closed while a job was still running.
    }
  }

  reveal(): void {
    this.panel.reveal(undefined, false);
  }

  dispose(): void {
    this.panel.dispose();
  }
}
