import * as vscode from 'vscode';
import { CommitSmithCommands } from './vscode/commands';
import { Activity } from './vscode/activity';
import { PANEL_VIEW_ID, SidePanel } from './vscode/sidePanel';
import { ToolPicker } from './vscode/statusBar';

export function activate(context: vscode.ExtensionContext): void {
  // The fake-CLI override is honoured only when the extension runs under test or development.
  const underTest = context.extensionMode !== vscode.ExtensionMode.Production;
  const picker = new ToolPicker(underTest ? process.env.COMMITSMITH_EXE_OVERRIDE : undefined);
  const activity = new Activity();
  const commands = new CommitSmithCommands(picker, context.extensionUri, activity);
  const panel = new SidePanel(context.extensionUri, commands, picker, activity);
  context.subscriptions.push(
    picker,
    activity,
    commands,
    panel,
    vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, panel),
    vscode.commands.registerCommand('commitsmith.writeMessage', commands.writeMessage),
    vscode.commands.registerCommand('commitsmith.writeAndCommit', commands.writeAndCommit),
    vscode.commands.registerCommand('commitsmith.smartSplit', commands.smartSplit),
    vscode.commands.registerCommand('commitsmith.push', commands.push),
    vscode.commands.registerCommand('commitsmith.pickModel', commands.pickModel),
    ...(underTest
      ? [
          vscode.commands.registerCommand('commitsmith.test.planTab', (arg) => commands.testPlanTab(arg)),
          vscode.commands.registerCommand('commitsmith.test.panel', (arg) => panel.testHook(arg)),
        ]
      : []),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('commitsmith')) void picker.refresh();
    }),
  );
  void picker.refresh();
}

export function deactivate(): void {}
