import * as vscode from 'vscode';
import type { Activity } from './activity';
import type { RecentEntry } from './panelModel';

export const RECENT_VIEW_ID = 'commitsmith.recent';

/** The last CommitSmith actions of this session, newest first. */
export class RecentView implements vscode.TreeDataProvider<RecentEntry>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly activity: Activity) {
    this.sub = activity.onDidChange(() => this.emitter.fire());
  }

  dispose(): void {
    this.sub.dispose();
    this.emitter.dispose();
  }

  getChildren(node?: RecentEntry): RecentEntry[] {
    return node ? [] : this.activity.recent();
  }

  getTreeItem(e: RecentEntry): vscode.TreeItem {
    if (e.kind === 'committed') {
      const t = new vscode.TreeItem(vscode.l10n.t('Committed {0} {1}', e.sha, e.subject));
      t.iconPath = new vscode.ThemeIcon('git-commit');
      t.tooltip = vscode.l10n.t('Click to copy the commit id');
      t.command = { command: 'commitsmith.copySha', title: '', arguments: [e.sha] };
      return t;
    }
    if (e.kind === 'pushed') {
      const t = new vscode.TreeItem(vscode.l10n.t('Pushed {0}', e.branch));
      t.iconPath = new vscode.ThemeIcon('cloud-upload');
      return t;
    }
    const t = new vscode.TreeItem(e.text);
    t.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
    t.tooltip = e.text;
    return t;
  }
}

/** Copies a commit id; only a plain hex id is accepted. */
export async function copySha(sha: unknown): Promise<void> {
  if (typeof sha !== 'string' || !/^[0-9a-f]{4,40}$/.test(sha)) return;
  await vscode.env.clipboard.writeText(sha);
  vscode.window.setStatusBarMessage(vscode.l10n.t('Copied {0}', sha), 3000);
}
