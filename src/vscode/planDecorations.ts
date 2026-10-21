import { join } from 'node:path';
import * as vscode from 'vscode';
import type { SplitPlan } from '../split/plan';

const key = (fsPath: string) => (process.platform === 'win32' ? fsPath.toLowerCase() : fsPath);

/** Shows each file's commit number in the Source Control list while the plan tab is open. */
export class PlanDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly registration = vscode.window.registerFileDecorationProvider(this);
  private badges = new Map<string, vscode.FileDecoration>();
  private uris: vscode.Uri[] = [];

  constructor(private readonly root: string) {}

  set(plan: SplitPlan): void {
    const old = this.uris;
    const next = new Map<string, vscode.FileDecoration>();
    const uris: vscode.Uri[] = [];
    const add = (path: string, badge: string, tooltip: string) => {
      const uri = vscode.Uri.file(join(this.root, path));
      uris.push(uri);
      next.set(key(uri.fsPath), new vscode.FileDecoration(badge, tooltip));
    };
    plan.groups.forEach((g, i) => g.files.forEach((f) => add(f, String(i + 1).slice(0, 2), g.message)));
    plan.unassigned.forEach((f) => add(f, '?', vscode.l10n.t('Not part of any commit')));
    this.badges = next;
    this.uris = uris;
    this.emitter.fire([...old, ...uris]);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    return this.badges.get(key(uri.fsPath));
  }

  dispose(): void {
    const old = this.uris;
    this.badges = new Map();
    this.uris = [];
    this.emitter.fire(old);
    this.registration.dispose();
    this.emitter.dispose();
  }
}
