import * as vscode from 'vscode';
import { AiError } from '../ai/types';
import { DEFAULT_DIFF_OPTIONS, DiffOptions, collectDiff } from '../git/diffCollector';
import { commitGroups } from '../git/commitEngine';
import { GitError, pathspecInput, runGit } from '../git/gitRunner';
import { resolveScope, Scope } from '../git/scope';
import { readStatus } from '../git/status';
import { cleanMessage } from '../message/clean';
import { buildMessagePrompt } from '../prompt/prompts';
import { readRepoContext } from '../prompt/repoContext';
import { decidePush, readPushInfo, runPush } from '../push/push';
import { GitRepository, getRepository } from './gitApi';
import { ToolPicker } from './statusBar';

export class CommitSmithCommands implements vscode.Disposable {
  private readonly busy = new Set<string>();
  private readonly log = vscode.window.createOutputChannel('CommitSmith');

  constructor(private readonly picker: ToolPicker) {}

  dispose(): void {
    this.log.dispose();
  }

  private cfg() {
    return vscode.workspace.getConfiguration('commitsmith');
  }

  private diffOptions(): DiffOptions {
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
    if (this.busy.has(found.root)) {
      void vscode.window.showInformationMessage(vscode.l10n.t('CommitSmith is already working on this repository'));
      return;
    }
    this.busy.add(found.root);
    try {
      await fn(found.root, found.repo);
    } catch (e) {
      await this.report(e);
    } finally {
      this.busy.delete(found.root);
    }
  }

  private async report(e: unknown): Promise<void> {
    if (e instanceof AiError) {
      if (e.kind === 'cancelled') return;
      if (e.kind === 'notFound') return this.reportMissing(this.picker.current()?.tool.displayName ?? 'AI');
      if (e.stderrTail) this.log.appendLine(e.stderrTail);
      const text = vscode.l10n.t('The AI failed ({0}): {1}', e.kind, e.message);
      if (!e.stderrTail) return void vscode.window.showErrorMessage(text);
      const show = vscode.l10n.t('Show log');
      if ((await vscode.window.showErrorMessage(text, show)) === show) this.log.show(true);
      return;
    }
    const msg = e instanceof GitError ? e.stderr.trim() || e.message : e instanceof Error ? e.message : String(e);
    this.log.appendLine(msg);
    void vscode.window.showErrorMessage(msg);
  }

  private async reportMissing(name: string): Promise<void> {
    const another = vscode.l10n.t('Pick another');
    if ((await vscode.window.showErrorMessage(vscode.l10n.t('{0} was not found', name), another)) === another) {
      await this.pickModel();
    }
  }

  /** Scope -> diff -> prompt -> AI -> cleaned message. Never touches the index. */
  private async generate(root: string): Promise<{ message: string; scope: Scope } | undefined> {
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
    if (!message) throw new AiError('badOutput', vscode.l10n.t('The AI returned an empty message'));
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
        if (f.committed) {
          const sha = result.done[result.done.length - 1]?.sha.slice(0, 7) ?? '';
          void vscode.window.showWarningMessage(
            vscode.l10n.t('Committed {0}, but refreshing the index failed: {1}', sha, f.error),
          );
        } else {
          this.log.appendLine(f.error);
          void vscode.window.showErrorMessage(vscode.l10n.t('Commit failed: {0}', f.error));
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
      vscode.l10n.t('{0} new files were not included', paths.length),
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

  smartSplit = async (_arg?: unknown): Promise<void> => {
    void vscode.window.showInformationMessage(vscode.l10n.t('Smart split is coming next'));
  };

  push = (arg?: unknown) =>
    this.withRepo(arg, async (root, repo) => {
      const info = await readPushInfo(root);
      const d = decidePush(info);
      if (d.kind === 'noRemote') {
        void vscode.window.showErrorMessage(vscode.l10n.t('This repository has no remote to push to'));
        return;
      }
      if (d.kind === 'nothing') {
        void vscode.window.showInformationMessage(
          info.branch ? vscode.l10n.t('Nothing to push') : vscode.l10n.t('Not on a branch'),
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
    });

  pickModel = (): Promise<void> => this.picker.pick();
}
