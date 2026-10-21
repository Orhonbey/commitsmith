import * as vscode from 'vscode';
import { createClaudeTool } from '../ai/claudeTool';
import { createCodexTool } from '../ai/codexTool';
import { detectTools } from '../ai/registry';
import type { AiTool, ModelInfo } from '../ai/types';

type Entry = { tool: AiTool; exe?: string; models: ModelInfo[] };

/** Test hook: point both tools at a fake executable (used by the extension smoke test). */
const EXE_OVERRIDE = process.env.COMMITSMITH_EXE_OVERRIDE;

export class ToolPicker implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  private entries: Entry[] = [];

  constructor() {
    this.item.command = 'commitsmith.pickModel';
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }

  private cfg() {
    return vscode.workspace.getConfiguration('commitsmith');
  }

  /** Re-detects the tools with fresh instances (Codex detection is cached per instance). */
  async refresh(): Promise<void> {
    const cfg = this.cfg();
    const tools = [
      createClaudeTool({ exeOverride: EXE_OVERRIDE }),
      createCodexTool({ exeOverride: EXE_OVERRIDE }),
    ];
    const detected = await detectTools(tools);
    this.entries = await Promise.all(
      detected.map(async ({ tool, exe }) => {
        let models: ModelInfo[] = [];
        if (exe) {
          try {
            models = await tool.listModels(cfg.get<string[]>(`models.${tool.id}`, []));
          } catch {
            models = [];
          }
        }
        return { tool, exe, models };
      }),
    );
    this.render();
  }

  /** The tool and model to use: the configured ones, else the first detected tool's first model. */
  current(): { tool: AiTool; model: string } | undefined {
    const cfg = this.cfg();
    const found = this.entries.filter((e) => e.exe);
    const entry = found.find((e) => e.tool.id === cfg.get<string>('tool')) ?? found[0];
    if (!entry) return undefined;
    const saved = cfg.get<string>('model', '');
    const model = entry.tool.id === cfg.get<string>('tool') && saved ? saved : entry.models[0]?.id;
    return model ? { tool: entry.tool, model } : undefined;
  }

  private render(): void {
    const cur = this.current();
    if (!cur) {
      this.item.text = '$(sparkle) ' + vscode.l10n.t('CommitSmith: no AI tool found');
    } else {
      const entry = this.entries.find((e) => e.tool === cur.tool)!;
      const label = entry.models.find((m) => m.id === cur.model)?.label ?? cur.model;
      this.item.text = `$(sparkle) ${cur.tool.displayName} · ${label}`;
    }
    const lines = this.entries.map((e) =>
      e.exe ? `${e.tool.displayName}: ${e.exe}` : `${e.tool.displayName}: ${vscode.l10n.t('not found')}`,
    );
    this.item.tooltip = [vscode.l10n.t('Choose the AI and model that write commit messages'), ...lines].join('\n');
  }

  async pick(): Promise<void> {
    await this.refresh();
    const cur = this.current();
    type Item = vscode.QuickPickItem & { toolId?: AiTool['id']; model?: string };
    const items: Item[] = [];
    for (const e of this.entries) {
      items.push({ label: e.tool.displayName, kind: vscode.QuickPickItemKind.Separator });
      if (!e.exe) {
        items.push({ label: '$(circle-slash) ' + vscode.l10n.t('not found') });
        continue;
      }
      for (const m of e.models) {
        const isCurrent = cur?.tool === e.tool && cur.model === m.id;
        items.push({
          label: (isCurrent ? '✓ ' : '') + m.label,
          description: m.detail,
          toolId: e.tool.id,
          model: m.id,
        });
      }
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: vscode.l10n.t('Choose the AI and model that write commit messages'),
    });
    if (!picked?.toolId || !picked.model) return;
    const cfg = this.cfg();
    await cfg.update('tool', picked.toolId, vscode.ConfigurationTarget.Global);
    await cfg.update('model', picked.model, vscode.ConfigurationTarget.Global);
    this.render();
  }
}
