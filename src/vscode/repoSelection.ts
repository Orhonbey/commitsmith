import * as vscode from 'vscode';

/** Which repository the Activity Bar views show; shared by the panel and the changes tree. */
export class RepoSelection implements vscode.Disposable {
  private root: string | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  dispose(): void {
    this.emitter.dispose();
  }

  /** The selected repository among the open `roots`; falls back to the first one. */
  resolve(roots: readonly string[]): string | undefined {
    if (!this.root || !roots.includes(this.root)) this.root = roots[0];
    return this.root;
  }

  select(root: string): void {
    if (this.root === root) return;
    this.root = root;
    this.emitter.fire();
  }
}
