import * as vscode from 'vscode';
import { RecentEntry, addRecent } from './panelModel';

/**
 * Session state shared by the commands and the Activity Bar panel: which repositories have a
 * CommitSmith job running (the busy guard) and the last few actions. In memory only.
 */
export class Activity implements vscode.Disposable {
  private readonly busy = new Set<string>();
  private list: RecentEntry[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  dispose(): void {
    this.emitter.dispose();
  }

  isBusy(root: string): boolean {
    return this.busy.has(root);
  }

  /** Returns false when `root` is already busy (the caller must not run its job). */
  tryEnter(root: string): boolean {
    if (this.busy.has(root)) return false;
    this.busy.add(root);
    this.emitter.fire();
    return true;
  }

  leave(root: string): void {
    if (this.busy.delete(root)) this.emitter.fire();
  }

  recent(): RecentEntry[] {
    return this.list;
  }

  record(entry: RecentEntry): void {
    this.list = addRecent(this.list, entry);
    this.emitter.fire();
  }
}
