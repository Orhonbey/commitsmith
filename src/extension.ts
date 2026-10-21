import * as vscode from 'vscode';
import { CommitSmithCommands } from './vscode/commands';
import { ToolPicker } from './vscode/statusBar';

export function activate(context: vscode.ExtensionContext): void {
  const picker = new ToolPicker();
  const commands = new CommitSmithCommands(picker);
  context.subscriptions.push(
    picker,
    commands,
    vscode.commands.registerCommand('commitsmith.writeMessage', commands.writeMessage),
    vscode.commands.registerCommand('commitsmith.writeAndCommit', commands.writeAndCommit),
    vscode.commands.registerCommand('commitsmith.smartSplit', commands.smartSplit),
    vscode.commands.registerCommand('commitsmith.push', commands.push),
    vscode.commands.registerCommand('commitsmith.pickModel', commands.pickModel),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('commitsmith')) void picker.refresh();
    }),
  );
  void picker.refresh();
}

export function deactivate(): void {}
