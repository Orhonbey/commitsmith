import * as vscode from 'vscode';
import { commitGroups } from '../git/commitEngine';
import { readStatus } from '../git/status';
import type { PlanLocks } from '../prompt/prompts';
import { toCommitGroups } from '../split/plan';
import { PlanState, fingerprintOf, handlePlanMessage } from '../split/planState';
import { PlanDecorations } from './planDecorations';
import { PlanPanel, ToWebview, webviewStrings } from './planPanel';
import { PlanResult, PlannerEnv, makePlan } from './splitPlanner';
import type { GitRepository } from './gitApi';

export interface SplitHost extends PlannerEnv {
  readonly extensionUri: vscode.Uri;
  /** Runs `fn` under the per-repository busy guard (AI run or commit run, not the open tab). */
  guard(root: string, fn: () => Promise<void>): Promise<void>;
  /** Shows the error to the user; `onText` receives the localized text first. Cancellation shows nothing. */
  report(e: unknown, onText?: (text: string) => void): Promise<void>;
  pushFlow(root: string, repo: GitRepository): Promise<void>;
}

/** One open "Commit plan" tab: its state, the AI regroup, the commit run and the SCM badges. */
export class SplitSession implements vscode.Disposable {
  private state: PlanState;
  private current: PlanResult;
  private working = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly panel: PlanPanel;
  private readonly decorations: PlanDecorations;
  private readonly watch: vscode.Disposable;

  constructor(
    private readonly host: SplitHost,
    private readonly root: string,
    private readonly repo: GitRepository,
    first: PlanResult,
    private readonly onClosed: () => void,
  ) {
    this.current = first;
    this.state = { plan: first.plan, stale: false, used: false, revision: 1 };
    this.decorations = new PlanDecorations(root);
    this.decorations.set(first.plan);
    this.watch = repo.state.onDidChange(() => this.scheduleCheck());
    this.panel = new PlanPanel(
      host.extensionUri,
      (raw) => void this.handle(raw),
      () => this.dispose(),
    );
    // Changes made while the AI was running are already in the working tree.
    void this.checkStale();
  }

  reveal(): void {
    this.panel.reveal();
  }

  /** Current plan state (extension tests). */
  snapshot(): PlanState {
    return this.state;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.watch.dispose();
    this.decorations.dispose();
    this.panel.dispose();
    this.onClosed();
  }

  private sendPlan(): void {
    const { scope, toolLabel, branch } = this.current;
    const msg: ToWebview = {
      type: 'plan',
      plan: this.state.plan,
      toolLabel,
      fileCount: scope.files.length,
      branch,
      newFiles: scope.files.filter((f) => f.isNew).map((f) => f.path),
      stale: this.state.stale,
      used: this.state.used,
      revision: this.state.revision,
      strings: webviewStrings(),
    };
    this.panel.post(msg);
  }

  /** Entry point for every message from the webview (also used by the extension tests). */
  async handle(raw: unknown): Promise<void> {
    if (this.disposed || this.working) return;
    const { state, action } = handlePlanMessage(this.state, raw);
    this.state = state;
    switch (action.kind) {
      case 'render':
        this.decorations.set(state.plan);
        this.sendPlan();
        break;
      case 'cancel':
        this.dispose();
        break;
      case 'invalid': {
        const text =
          action.code === 'stale'
            ? vscode.l10n.t('Changes changed since this plan — Regroup before committing')
            : action.code === 'noneChecked'
              ? vscode.l10n.t('Check at least one commit')
              : vscode.l10n.t('A checked commit has an empty message');
        this.panel.post({ type: 'error', text });
        break;
      }
      case 'commit':
        await this.commit(action.pushAfter);
        break;
      case 'regroup':
        await this.regroup(action.locks);
        break;
      case 'ignore':
        break;
    }
  }

  private async run(busyText: string, job: () => Promise<void>): Promise<void> {
    await this.host.guard(this.root, async () => {
      this.working = true;
      this.panel.post({ type: 'busy', text: busyText });
      try {
        await job();
      } catch (e) {
        await this.host.report(e, (text) => this.panel.post({ type: 'error', text }));
      } finally {
        this.working = false;
      }
    });
  }

  private async commit(pushAfter: boolean): Promise<void> {
    let ok = false;
    await this.run(vscode.l10n.t('Committing...'), async () => {
      // Final check: the plan must still describe the working tree.
      if (fingerprintOf(await readStatus(this.root)) !== this.current.fingerprint) {
        this.state = { ...this.state, stale: true };
        this.sendPlan();
        this.panel.post({ type: 'error', text: vscode.l10n.t('Changes changed since this plan — Regroup before committing') });
        return;
      }
      const groups = toCommitGroups(this.state.plan, this.current.scope.files);
      const result = await commitGroups(this.root, this.current.scope.kind, groups);
      await this.repo.status();
      this.state = { ...this.state, used: true };
      ok = !result.failed;
      this.panel.post({ type: 'result', result });
    });
    if (ok && pushAfter && !this.disposed) await this.host.guard(this.root, () => this.host.pushFlow(this.root, this.repo));
  }

  private async regroup(locks: PlanLocks): Promise<void> {
    let fresh: PlanResult | undefined;
    await this.run(vscode.l10n.t('Regrouping...'), async () => {
      fresh = await makePlan(this.host, this.root, locks);
    });
    if (fresh) {
      this.current = fresh;
      this.state = { plan: fresh.plan, stale: false, used: false, revision: this.state.revision + 1 };
      this.decorations.set(fresh.plan);
    }
    if (this.disposed) return;
    this.sendPlan();
    if (fresh) void this.checkStale();
  }

  private scheduleCheck(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.checkStale(), 500);
  }

  /** Flags the plan when the scoped changes differ from the ones the AI saw. */
  private async checkStale(): Promise<void> {
    if (this.disposed || this.working || this.state.used) return;
    try {
      const fp = fingerprintOf(await readStatus(this.root));
      if (this.disposed || this.working || this.state.used) return;
      const stale = fp !== this.current.fingerprint;
      if (stale !== this.state.stale) {
        this.state = { ...this.state, stale };
        this.sendPlan();
      }
    } catch {
      // A status read racing with a git operation: the next change event retries.
    }
  }
}
