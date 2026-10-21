import * as vscode from 'vscode';
import { AiError } from '../ai/types';
import { DEFAULT_DIFF_OPTIONS, DiffOptions, collectDiff } from '../git/diffCollector';
import { commitGroups } from '../git/commitEngine';
import { GitError, pathspecInput, runGit } from '../git/gitRunner';
import { resolveScope, Scope } from '../git/scope';
import { readStatus } from '../git/status';
import { cleanMessage } from '../message/clean';
import { buildMessagePrompt } from '../prompt/prompts';
import { PlanError } from '../split/plan';
import { readRepoContext } from '../prompt/repoContext';
import { decidePush, readPushInfo, runPush } from '../push/push';
import { GitRepository, getRepository } from './gitApi';
import { SplitHost, SplitSession } from './splitSession';
import { makePlan } from './splitPlanner';
import { ToolPicker } from './statusBar';

export class CommitSmithCommands implements vscode.Disposable, SplitHost {
  private readonly busy = new Set<string>();
  private readonly log = vscode.window.createOutputChannel('CommitSmith');
  private session: SplitSession | undefined;

  constructor(
    readonly picker: ToolPicker,
    readonly extensionUri: vscode.Uri,
  ) {}

  dispose(): void {
    this.session?.dispose();
    this.log.dispose();
  }

  cfg() {
    return vscode.workspace.getConfiguration('commitsmith');
  }

  diffOptions(): DiffOptions {
    const c = this.cfg();
    return {
      summaryOnlyExtensions: c.get<string[]>('summaryOnlyExtensions', DEFAULT_DIFF_OPTIONS.summaryOnlyExtensions),
      maxFileDiffBytes: c.get<number>('maxFileDiffBytes', DEFAULT_DIFF_OPTIONS.maxFileDiffBytes),
      maxTotalBytes: c.get<number>('maxTotalBytes', DEFAULT_DIFF_OPTIONS.maxTotalBytes),
    };
  }

  /** Runs `fn` for the repository the command was invoked on; one AI/git job per repository. */
  private async withRepo(arg: unknown, fn: (root: string, repo: GitRepository) => Promise<void>): Promise<void> {
    const found = await getRepository(arg);
    if (!found) return;
    await this.guard(found.root, () => fn(found.root, found.repo));
  }

  /** The per-repository busy guard: one AI/git job at a time. Errors are reported, not thrown. */
  async guard(root: string, fn: () => Promise<void>): Promise<void> {
    if (this.busy.has(root)) {
      void vscode.window.showInformationMessage(vscode.l10n.t('CommitSmith is already working on this repository'));
      return;
    }
    this.busy.add(root);
    try {
      await fn();
    } catch (e) {
      await this.report(e);
    } finally {
      this.busy.delete(root);
    }
  }

  /** Shows a localized error; `detail` (English CLI/git output) only goes to the log. */
  private async fail(text: string, detail: string): Promise<void> {
    if (detail) this.log.appendLine(detail);
    const show = vscode.l10n.t('Show log');
    if ((await vscode.window.showErrorMessage(text, show)) === show) this.log.show(true);
  }

  async report(e: unknown): Promise<void> {
    if (e instanceof AiError) {
      if (e.kind === 'cancelled') return;
      if (e.kind === 'notFound') return this.reportMissing(this.picker.current()?.tool.displayName ?? 'AI');
      const detail = [`${e.kind}: ${e.message}`, e.stderrTail].filter(Boolean).join('\n');
      let text: string;
      if (e.kind === 'timeout') {
        text = vscode.l10n.t('The AI did not answer within {0} seconds', this.cfg().get<number>('timeoutSeconds', 180));
      } else if (e.kind === 'exit') {
        text = vscode.l10n.t('The AI command failed. Check that you are signed in; the log has details');
      } else {
        text = vscode.l10n.t('The AI returned an answer CommitSmith could not read');
      }
      return this.fail(text, detail);
    }
    if (e instanceof PlanError) {
      return this.fail(vscode.l10n.t('The AI could not produce a usable commit plan. The log has details'), e.message);
    }
    if (e instanceof GitError) {
      return this.fail(vscode.l10n.t('A git command failed'), e.stderr.trim() || e.message);
    }
    return this.fail(
      vscode.l10n.t('CommitSmith hit an unexpected error'),
      e instanceof Error ? e.stack ?? e.message : String(e),
    );
  }

  async reportMissing(name: string): Promise<void> {
    const another = vscode.l10n.t('Pick another');
    if ((await vscode.window.showErrorMessage(vscode.l10n.t('{0} was not found', name), another)) === another) {
      await this.pickModel();
    }
  }

  /** Scope -> diff -> prompt -> AI -> cleaned message. Never touches the index. */
  private async generate(root: string): Promise<{ message: string; scope: Scope } | undefined> {
    await this.picker.whenReady();
    const cur = this.picker.current();
    if (!cur) {
      await this.reportMissing('AI');
      return undefined;
    }
    const cfg = this.cfg();
    const scope = resolveScope(await readStatus(root), { includeUntracked: cfg.get<boolean>('includeUntracked', false) });
    if (scope.files.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to describe'));
      return undefined;
    }
    const diffs = await collectDiff(root, scope, this.diffOptions());
    const prompt = buildMessagePrompt(await readRepoContext(root), diffs, cfg.get<string>('messageLanguage', 'English'));
    const raw = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('{0} is writing the message...', cur.tool.displayName),
        cancellable: true,
      },
      (_progress, token) => {
        const ctl = new AbortController();
        token.onCancellationRequested(() => ctl.abort());
        return cur.tool.run(prompt, {
          model: cur.model,
          cwd: root,
          timeoutMs: cfg.get<number>('timeoutSeconds', 180) * 1000,
          signal: ctl.signal,
        });
      },
    );
    const message = cleanMessage(raw, cfg.get<boolean>('stripAiAttribution', true));
    if (!message) {
      await this.fail(vscode.l10n.t('The AI returned an empty message'), 'badOutput: empty message');
      return undefined;
    }
    return { message, scope };
  }

  writeMessage = (arg?: unknown) =>
    this.withRepo(arg, async (root, repo) => {
      const out = await this.generate(root);
      if (out) repo.inputBox.value = out.message;
    });

  writeAndCommit = (arg?: unknown) =>
    this.withRepo(arg, async (root, repo) => {
      const out = await this.generate(root);
      if (!out) return;
      const paths = [...new Set(out.scope.files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path])))];
      const result = await commitGroups(root, out.scope.kind, [{ message: out.message, paths }]);
      await repo.status();
      if (result.failed) {
        const f = result.failed;
        this.log.appendLine(f.error);
        if (f.committed) {
          const sha = result.done[result.done.length - 1]?.sha.slice(0, 7) ?? '';
          void vscode.window.showWarningMessage(
            vscode.l10n.t('Committed {0}, but refreshing the index failed. The log has details', sha),
          );
        } else if (f.code === 'inProgress') {
          void vscode.window.showErrorMessage(
            vscode.l10n.t('A merge, cherry-pick, revert or rebase is in progress. Finish it first'),
          );
        } else if (f.code === 'emptyGroup') {
          void vscode.window.showErrorMessage(vscode.l10n.t('There are no files to commit'));
        } else if (f.code !== 'cancelled') {
          await this.fail(vscode.l10n.t('Commit failed. The log has details'), '');
        }
        return;
      }
      void vscode.window.showInformationMessage(vscode.l10n.t('Committed {0}', result.done[0].sha.slice(0, 7)));
      if (out.scope.leftOutUntracked.length > 0) void this.offerLeftOut(root, repo, out.scope.leftOutUntracked, arg);
    });

  private async offerLeftOut(root: string, repo: GitRepository, paths: string[], arg: unknown): Promise<void> {
    const stage = vscode.l10n.t('Stage them');
    const split = vscode.l10n.t('Smart split');
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t('New files not included: {0}', paths.length),
      stage,
      split,
    );
    if (choice === stage) {
      try {
        await runGit(root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: pathspecInput(paths) });
        await repo.status();
      } catch (e) {
        await this.report(e);
      }
    } else if (choice === split) {
      await this.smartSplit(arg);
    }
  }

  /** Opens the plan tab (re-focuses it if open). The busy guard covers only the AI run, not the open tab. */
  smartSplit = async (arg?: unknown): Promise<void> => {
    if (this.session) {
      this.session.reveal();
      return;
    }
    await this.withRepo(arg, async (root, repo) => {
      const first = await makePlan(this, root);
      if (!first) return;
      this.session = new SplitSession(this, root, repo, first, () => {
        this.session = undefined;
      });
    });
  };

  /** Extension tests only: drives the open plan tab without a webview. */
  async testPlanTab(arg: { action: 'state' } | { action: 'message'; message: unknown }): Promise<unknown> {
    if (arg.action === 'message') await this.session?.handle(arg.message);
    return this.session?.snapshot();
  }

  push = (arg?: unknown) => this.withRepo(arg, (root, repo) => this.pushFlow(root, repo));

  /** Push with its confirmations; shared by the Push command and Smart split's "Push when done". */
  async pushFlow(root: string, repo: GitRepository): Promise<void> {
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
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Pushing...') },
      () => runPush(root, d, info.branch),
    );
    await repo.status();
    void vscode.window.showInformationMessage(vscode.l10n.t('Pushed {0}', info.branch));
  }

  pickModel = (): Promise<void> => this.picker.pick();
}
