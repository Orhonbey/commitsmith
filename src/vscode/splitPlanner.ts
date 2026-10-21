import * as vscode from 'vscode';
import { DiffOptions, collectDiff } from '../git/diffCollector';
import { resolveScope, Scope } from '../git/scope';
import { readStatus } from '../git/status';
import { PlanLocks, SPLIT_SCHEMA, buildSplitPrompt } from '../prompt/prompts';
import { readRepoContext } from '../prompt/repoContext';
import { PlanError, SplitPlan, pairCompanions, parsePlan } from '../split/plan';
import { fingerprintOf } from '../split/planState';
import type { ToolPicker } from './statusBar';

export type PlanResult = {
  plan: SplitPlan;
  scope: Scope;
  toolLabel: string;
  branch: string;
  /** Identity of the scoped changes when the plan was made, to detect later edits. */
  fingerprint: string;
};

export type PlannerEnv = {
  picker: ToolPicker;
  cfg(): vscode.WorkspaceConfiguration;
  diffOptions(): DiffOptions;
  reportMissing(name: string): Promise<void>;
};

/** Scope (untracked files always included) -> diff -> AI -> validated plan. Never touches the index. */
export async function makePlan(env: PlannerEnv, root: string, locks?: PlanLocks): Promise<PlanResult | undefined> {
  await env.picker.whenReady();
  const cur = env.picker.current();
  if (!cur) {
    await env.reportMissing('AI');
    return undefined;
  }
  const cfg = env.cfg();
  const status = await readStatus(root);
  const scope = resolveScope(status, { includeUntracked: true });
  if (scope.files.length === 0) {
    void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to split'));
    return undefined;
  }
  const ctx = await readRepoContext(root);
  const diffs = await collectDiff(root, scope, env.diffOptions());
  const prompt = buildSplitPrompt(ctx, diffs, cfg.get<string>('messageLanguage', 'English'), locks);

  const plan = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: vscode.l10n.t('{0} is analysing {1} files...', cur.tool.displayName, scope.files.length),
      cancellable: true,
    },
    async (_progress, token) => {
      const ctl = new AbortController();
      token.onCancellationRequested(() => ctl.abort());
      const ask = (p: string) =>
        cur.tool.run(p, {
          model: cur.model,
          cwd: root,
          jsonSchema: SPLIT_SCHEMA,
          timeoutMs: cfg.get<number>('timeoutSeconds', 180) * 1000,
          signal: ctl.signal,
        });
      const build = (raw: string) => pairCompanions(parsePlan(raw, scope.files, locks), scope.files);
      try {
        return build(await ask(prompt));
      } catch (e) {
        if (!(e instanceof PlanError)) throw e;
        // One retry with the problem spelled out; a second failure surfaces as a PlanError.
        return build(await ask(`${prompt}\n\nYour previous answer was rejected: ${e.message} Answer again with a corrected JSON plan.`));
      }
    },
  );
  return { plan, scope, toolLabel: cur.tool.displayName, branch: ctx.branch, fingerprint: fingerprintOf(status) };
}
