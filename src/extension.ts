import * as vscode from 'vscode';
import { CommitSmithCommands } from './vscode/commands';
import { Activity } from './vscode/activity';
import { CHANGES_VIEW_ID, ChangesView } from './vscode/changesView';
import { RECENT_VIEW_ID, RecentView, copySha } from './vscode/recentView';
import { RepoSelection } from './vscode/repoSelection';
import { PANEL_VIEW_ID, SidePanel } from './vscode/sidePanel';
import { ToolPicker } from './vscode/statusBar';

export function activate(context: vscode.ExtensionContext): void {
  // The fake-CLI override is honoured only when the extension runs under test or development.
  const underTest = context.extensionMode !== vscode.ExtensionMode.Production;
  const picker = new ToolPicker(underTest ? process.env.COMMITSMITH_EXE_OVERRIDE : undefined);
  const activity = new Activity();
  const commands = new CommitSmithCommands(picker, context.extensionUri, activity);
  const selection = new RepoSelection();
  const panel = new SidePanel(context.extensionUri, commands, picker, activity, selection);
  const changes = new ChangesView(selection, activity);
  const recent = new RecentView(activity);
  context.subscriptions.push(
    picker,
    activity,
    commands,
    panel,
    selection,
    changes,
    recent,
    vscode.window.registerWebviewViewProvider(PANEL_VIEW_ID, panel),
    vscode.window.registerTreeDataProvider(CHANGES_VIEW_ID, changes),
    vscode.window.registerTreeDataProvider(RECENT_VIEW_ID, recent),
    vscode.commands.registerCommand('commitsmith.writeMessage', commands.writeMessage),
    vscode.commands.registerCommand('commitsmith.writeAndCommit', commands.writeAndCommit),
    vscode.commands.registerCommand('commitsmith.smartSplit', commands.smartSplit),
    vscode.commands.registerCommand('commitsmith.push', commands.push),
    vscode.commands.registerCommand('commitsmith.pickModel', commands.pickModel),
    vscode.commands.registerCommand('commitsmith.refreshChanges', () => changes.refresh(0)),
    vscode.commands.registerCommand('commitsmith.stage', changes.stage),
    vscode.commands.registerCommand('commitsmith.unstage', changes.unstage),
    vscode.commands.registerCommand('commitsmith.discard', changes.discard),
    vscode.commands.registerCommand('commitsmith.stageAll', changes.stageAll),
    vscode.commands.registerCommand('commitsmith.unstageAll', changes.unstageAll),
    vscode.commands.registerCommand('commitsmith.discardAll', changes.discardAll),
    vscode.commands.registerCommand('commitsmith.openFile', changes.openFile),
    vscode.commands.registerCommand('commitsmith.copyPath', changes.copyPath),
    vscode.commands.registerCommand('commitsmith.openChange', changes.openChange),
    vscode.commands.registerCommand('commitsmith.copySha', copySha),
    ...(underTest
      ? [
          vscode.commands.registerCommand('commitsmith.test.planTab', (arg) => commands.testPlanTab(arg)),
          vscode.commands.registerCommand('commitsmith.test.panel', (arg) => panel.testHook(arg)),
          vscode.commands.registerCommand('commitsmith.test.changes', () => changes.testHook()),
          vscode.commands.registerCommand('commitsmith.test.recent', () => recent.getChildren()),
        ]
      : []),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('commitsmith')) void picker.refresh();
    }),
  );
  void picker.refresh();
}

export function deactivate(): void {}
