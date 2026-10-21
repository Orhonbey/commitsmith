import * as vscode from 'vscode';
import { AiError } from '../ai/types';
import { DEFAULT_DIFF_OPTIONS, DiffOptions, collectDiff } from '../git/diffCollector';
import { CommitResult, commitGroups } from '../git/commitEngine';
import { GitError, pathspecInput, runGit } from '../git/gitRunner';
import { resolveScope, Scope, scopeAction } from '../git/scope';
import { readStatus } from '../git/status';
import { cleanMessage } from '../message/clean';
import { buildMessagePrompt } from '../prompt/prompts';
import { PlanError } from '../split/plan';
import { readRepoContext } from '../prompt/repoContext';
import { commitFailureText, offerIndexRefresh } from './commitFeedback';
import { Activity } from './activity';
import type { RecentEntry } from './panelModel';
import { GitRepository, getRepository } from './gitApi';
import { pushFlow } from './pushFlow';
import { SplitHost, SplitSession } from './splitSession';
import { makePlan } from './splitPlanner';
import { ToolPicker } from './statusBar';

export class CommitSmithCommands implements vscode.Disposable, SplitHost {
  private readonly log = vscode.window.createOutputChannel('CommitSmith');
  /** One plan tab per repository. */
  private readonly sessions = new Map<string, SplitSession>();

  constructor(
    readonly picker: ToolPicker,
    readonly extensionUri: vscode.Uri,
    /** The busy guard and recent list, shared with the Activity Bar panel. */
    readonly activity: Activity = new Activity(),
  ) {}

  record(entry: RecentEntry): void {
    this.activity.record(entry);
  }

  dispose(): void {
    for (const s of [...this.sessions.values()]) s.dispose();
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
    if (!this.activity.tryEnter(root)) {
      void vscode.window.showInformationMessage(vscode.l10n.t('CommitSmith is already working on this repository'));
      return;
    }
    try {
      await fn();
    } catch (e) {
      await this.report(e);
    } finally {
      this.activity.leave(root);
    }
  }

  /** Shows a localized error; `detail` (English CLI/git output) only goes to the log. */
  private async fail(text: string, detail: string, onText?: (text: string) => void): Promise<void> {
    if (detail) this.log.appendLine(detail);
    this.record({ kind: 'failed', text });
    onText?.(text);
    const show = vscode.l10n.t('Show log');
    if ((await vscode.window.showErrorMessage(text, show)) === show) this.log.show(true);
  }

  async report(e: unknown, onText?: (text: string) => void): Promise<void> {
    if (e instanceof AiError) {
      if (e.kind === 'cancelled') return;
      if (e.kind === 'notFound') return this.reportMissing(this.picker.current()?.tool.displayName ?? 'AI', onText);
      const detail = [`${e.kind}: ${e.message}`, e.stderrTail].filter(Boolean).join('\n');
      let text: string;
      if (e.kind === 'timeout') {
        text = vscode.l10n.t('The AI did not answer within {0} seconds', this.cfg().get<number>('timeoutSeconds', 180));
      } else if (e.kind === 'exit') {
        text = vscode.l10n.t('The AI command failed. Check that you are signed in; the log has details');
      } else {
        text = vscode.l10n.t('The AI returned an answer CommitSmith could not read');
      }
      return this.fail(text, detail, onText);
    }
    if (e instanceof PlanError) {
      return this.fail(vscode.l10n.t('The AI could not produce a usable commit plan. The log has details'), e.message, onText);
    }
    if (e instanceof GitError) {
      return this.fail(vscode.l10n.t('A git command failed'), e.stderr.trim() || e.message, onText);
    }
    return this.fail(
      vscode.l10n.t('CommitSmith hit an unexpected error'),
      e instanceof Error ? e.stack ?? e.message : String(e),
      onText,
    );
  }

  /** Explains why no tool can run: the chosen one is missing, has no models, or nothing was found. */
  async reportNoTool(onText?: (text: string) => void): Promise<void> {
    const c = this.picker.choice();
    if (c.kind === 'noModels') {
      return this.reportMissing(this.picker.displayName(c.id), onText, vscode.l10n.t('{0} has no models. Add some in commitsmith.models.{1}', this.picker.displayName(c.id), c.id));
    }
    return this.reportMissing(c.kind === 'missing' ? this.picker.displayName(c.id) : 'AI', onText);
  }

  async reportMissing(name: string, onText?: (text: string) => void, message?: string): Promise<void> {
    const another = vscode.l10n.t('Pick another');
    const text = message ?? vscode.l10n.t('{0} was not found', name);
    this.record({ kind: 'failed', text });
    onText?.(text);
    if ((await vscode.window.showErrorMessage(text, another)) === another) {
      await this.pickModel();
    }
  }

  /** Scope -> diff -> prompt -> AI -> cleaned message. Never touches the index. */
  private async generate(root: string, repo: GitRepository, arg: unknown): Promise<{ message: string; scope: Scope } | undefined> {
    await this.picker.whenReady();
    const cur = this.picker.current();
    if (!cur) {
      await this.reportNoTool();
      return undefined;
    }
    const cfg = this.cfg();
    const scope = resolveScope(await readStatus(root), { includeUntracked: cfg.get<boolean>('includeUntracked', false) });
    const action = scopeAction(scope);
    if (action !== 'describe') {
      // Only new files changed: offer them (Stage them / Smart split) rather than "nothing to describe".
      if (action === 'offerNewFiles') void this.offerLeftOut(root, repo, scope.leftOutUntracked, arg);
      else void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to describe'));
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
      const out = await this.generate(root, repo, arg);
      if (out) repo.inputBox.value = out.message;
    });

  writeAndCommit = (arg?: unknown) =>
    this.withRepo(arg, async (root, repo) => {
      const out = await this.generate(root, repo, arg);
      if (!out) return;
      const paths = [...new Set(out.scope.files.flatMap((f) => (f.origPath ? [f.path, f.origPath] : [f.path])))];
      const result = await commitGroups(root, out.scope.kind, [{ message: out.message, paths }]);
      await repo.status();
      if (result.failed) {
        const f = result.failed;
        this.log.appendLine(f.error);
        if (f.committed) {
          this.record({ kind: 'committed', sha: result.done[result.done.length - 1].sha.slice(0, 7), subject: out.message.split('\n')[0] });
          return this.refreshAfterCommit(root, repo, result);
        }
        // Nothing was committed: keep the message so a retry does not cost another AI run.
        repo.inputBox.value = out.message;
        const text = commitFailureText(f, result.done);
        if (!text) return;
        if (f.code === 'inProgress' || f.code === 'emptyGroup') {
          this.record({ kind: 'failed', text });
          void vscode.window.showErrorMessage(text);
        }
        else await this.fail(text, '');
        return;
      }
      this.record({ kind: 'committed', sha: result.done[0].sha.slice(0, 7), subject: out.message.split('\n')[0] });
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
      // Staging writes the index: it takes the same per-repository lock as the other jobs.
      await this.guard(root, async () => {
        await runGit(root, ['add', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: pathspecInput(paths) });
        await repo.status();
      });
    } else if (choice === split) {
      await this.smartSplit(arg);
    }
  }

  /** Opens the plan tab (re-focuses that repository's tab if open). The busy guard covers only the AI run. */
  smartSplit = async (arg?: unknown): Promise<void> => {
    const found = await getRepository(arg);
    if (!found) return;
    const open = this.sessions.get(found.root);
    if (open) {
      open.reveal();
      return;
    }
    await this.guard(found.root, async () => {
      const first = await makePlan(this, found.root);
      if (!first) return;
      const session: SplitSession = new SplitSession(this, found.root, found.repo, first, () => {
        if (this.sessions.get(found.root) === session) this.sessions.delete(found.root);
      });
      this.sessions.set(found.root, session);
    });
  };

  /** Extension tests only: drives the open plan tab without a webview. */
  async testPlanTab(arg: { action: 'state' } | { action: 'message'; message: unknown }): Promise<unknown> {
    const session = [...this.sessions.values()][0];
    if (arg.action === 'message') await session?.handle(arg.message);
    return session?.snapshot();
  }

  push = (arg?: unknown) => this.withRepo(arg, (root, repo) => this.pushFlow(root, repo));

  /** The commit landed but the index refresh failed: modal warning with a "Retry index refresh" action. */
  refreshAfterCommit(root: string, repo: GitRepository, result: CommitResult): Promise<void> {
    return offerIndexRefresh(root, repo, result, this.log);
  }

  logLine(text: string): void {
    this.log.appendLine(text);
  }

  /** Push with its confirmations; shared by the Push command and Smart split's "Push when done". */
  pushFlow(root: string, repo: GitRepository): Promise<void> {
    return pushFlow(root, repo, this.log, (e) => this.record(e));
  }

  pickModel = (): Promise<void> => this.picker.pick();
}
