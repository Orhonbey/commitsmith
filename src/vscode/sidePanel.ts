import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readStatus } from '../git/status';
import { readPushInfo } from '../push/push';
import type { Activity } from './activity';
import type { CommitSmithCommands } from './commands';
import { GitRepository, RepoWatcher, getApi } from './gitApi';
import { PanelModel, buildPanelModel } from './panelModel';
import type { RepoSelection } from './repoSelection';
import type { ToolPicker } from './statusBar';

export const PANEL_VIEW_ID = 'commitsmith.panel';

/** The only actions the panel may run; anything else from the webview is dropped. */
export const PANEL_ACTIONS = ['writeMessage', 'writeAndCommit', 'smartSplit', 'push'] as const;
export type PanelAction = (typeof PANEL_ACTIONS)[number];

export type PanelMessage =
  | { type: 'ready' }
  | { type: 'pickModel' }
  | { type: 'run'; action: PanelAction }
  | { type: 'selectRepo'; root: string }
  | { type: 'setMessage'; value: string };

/** The longest commit message the webview may write into the Source Control box. */
export const MAX_MESSAGE_CHARS = 10_000;

/** Validates a message from the webview; `roots` are the repositories that are open right now. */
export function parsePanelMessage(raw: unknown, roots: readonly string[]): PanelMessage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'pickModel':
      return { type: m.type };
    case 'run':
      return PANEL_ACTIONS.includes(m.action as PanelAction) ? { type: 'run', action: m.action as PanelAction } : undefined;
    case 'selectRepo':
      return typeof m.root === 'string' && roots.includes(m.root) ? { type: 'selectRepo', root: m.root } : undefined;
    case 'setMessage':
      return typeof m.value === 'string' && m.value.length <= MAX_MESSAGE_CHARS ? { type: 'setMessage', value: m.value } : undefined;
    default:
      return undefined;
  }
}

/** Every string the webview shows, localized here so media/panel.js holds no literals. */
export function panelStrings(): Record<string, string> {
  return {
    pickTitle: vscode.l10n.t('Choose the AI and model that write commit messages'),
    noTool: vscode.l10n.t('No AI tool found'),
    toolMissing: vscode.l10n.t('{0} was not found'),
    toolNoModels: vscode.l10n.t('{0} has no models'),
    found: vscode.l10n.t('found'),
    notFound: vscode.l10n.t('not found'),
    repository: vscode.l10n.t('Repository'),
    messagePlaceholder: vscode.l10n.t('Commit message (the AI can write it)'),
    writeMessage: vscode.l10n.t('Write message'),
    writeAndCommit: vscode.l10n.t('Write + Commit'),
    smartSplit: vscode.l10n.t('Smart split'),
    push: vscode.l10n.t('Push'),
    pushCount: vscode.l10n.t('Push · {0}'),
    working: vscode.l10n.t('working…'),
    lookStaged: vscode.l10n.t('Looks at: Staged ({0})'),
    lookAll: vscode.l10n.t('Looks at: All changes ({0})'),
    branchUpstream: vscode.l10n.t('{0} → {1}'),
    branchNoUpstream: vscode.l10n.t('{0} → no upstream'),
    commitsToPush: vscode.l10n.t('{0} commits to push'),
    noRemote: vscode.l10n.t('This repository has no remote to push to'),
    unborn: vscode.l10n.t('Nothing to push yet. Make a first commit'),
    detached: vscode.l10n.t('Not on a branch'),
    noRepo: vscode.l10n.t('No Git repository is open'),
  };
}

/** The Activity Bar webview: AI row, commit message box and the four actions for the selected repository. */
export class SidePanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private roots: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  /** The commit message the webview was last told about (or typed itself). */
  private known = '';
  private seq = 0;
  private readonly subs: vscode.Disposable[] = [];
  /** Counts resolveWebviewView calls (extension tests check the provider was reached). */
  resolved = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly commands: CommitSmithCommands,
    private readonly picker: ToolPicker,
    private readonly activity: Activity,
    private readonly selection: RepoSelection,
  ) {
    const changed = () => this.schedule();
    this.subs.push(
      picker.onDidChange(changed),
      selection.onDidChange(changed),
      new RepoWatcher(changed),
      activity.onDidChange(changed),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('commitsmith')) changed();
      }),
    );
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.stopPolling();
    for (const s of this.subs) s.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.resolved++;
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((raw: unknown) => void this.handle(raw));
    // The git API has no event for the input box, so while the view is showing it is read once a second.
    const syncPolling = () => (view.visible ? this.startPolling() : this.stopPolling());
    view.onDidChangeVisibility(() => {
      syncPolling();
      if (view.visible) this.schedule(0);
    });
    view.onDidDispose(() => {
      this.stopPolling();
      if (this.view === view) this.view = undefined;
    });
    syncPolling();
  }

  private html(web: vscode.Webview, media: vscode.Uri): string {
    const nonce = randomBytes(16).toString('base64');
    const css = web.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    const js = web.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    const csp = `default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';`;
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>CommitSmith</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }

  private startPolling(): void {
    this.poll ??= setInterval(() => void this.syncMessage(), 1000);
  }

  private stopPolling(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  /** Tells the webview when the Source Control box changed behind its back (it ignores that while the user types). */
  private async syncMessage(): Promise<void> {
    if (!this.view?.visible) return;
    const repo = await this.repo();
    const value = repo?.inputBox.value ?? '';
    if (value === this.known) return;
    this.known = value;
    void this.view?.webview.postMessage({ type: 'message', value });
  }

  private async repo(): Promise<GitRepository | undefined> {
    const api = await getApi();
    const root = this.selection.resolve((api?.repositories ?? []).map((r) => r.rootUri.fsPath));
    return api?.repositories.find((r) => r.rootUri.fsPath === root);
  }

  /** Refresh only while the view is visible; a hidden view refreshes when it is shown again. */
  private schedule(delay = 300): void {
    if (!this.view?.visible) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  async handle(raw: unknown): Promise<void> {
    const msg = parsePanelMessage(raw, this.roots);
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        await this.refresh();
        break;
      case 'pickModel':
        await this.commands.pickModel();
        break;
      case 'selectRepo':
        this.selection.select(msg.root);
        await this.refresh();
        break;
      case 'setMessage': {
        const repo = await this.repo();
        if (!repo) return;
        this.known = msg.value;
        repo.inputBox.value = msg.value;
        break;
      }
      case 'run': {
        const root = this.selection.resolve(this.roots);
        if (!root || this.activity.isBusy(root)) return;
        // The same argument the SCM title-bar buttons pass, so getRepository finds the repository.
        await this.commands[msg.action]({ rootUri: vscode.Uri.file(root) });
        break;
      }
    }
  }

  /** Extension tests only: drives the panel without a webview and reports whether the view resolved. */
  async testHook(arg?: { message?: unknown }): Promise<{ resolved: number; model: PanelModel }> {
    await this.buildModel(); // learns the open repositories, which messages are validated against
    if (arg?.message !== undefined) await this.handle(arg.message);
    return { resolved: this.resolved, model: await this.buildModel() };
  }

  /** The model for the selected repository (also used by the extension tests). */
  async buildModel(): Promise<PanelModel> {
    const api = await getApi();
    this.roots = (api?.repositories ?? []).map((r) => r.rootUri.fsPath);
    const root = this.selection.resolve(this.roots);
    const message = api?.repositories.find((r) => r.rootUri.fsPath === root)?.inputBox.value ?? '';
    this.known = message;
    let status: Awaited<ReturnType<typeof readStatus>> = [];
    let push: Awaited<ReturnType<typeof readPushInfo>> | undefined;
    if (root) {
      try {
        [status, push] = await Promise.all([readStatus(root), readPushInfo(root)]);
      } catch {
        // A read racing with a git operation: the next change event retries.
      }
    }
    return buildPanelModel({
      ai: this.picker.aiRow(),
      repos: this.roots,
      selected: root,
      status,
      includeUntracked: vscode.workspace.getConfiguration('commitsmith').get<boolean>('includeUntracked', false),
      push,
      busy: root ? this.activity.isBusy(root) : false,
      message,
    });
  }

  private async refresh(): Promise<void> {
    if (!this.view) return;
    const mine = ++this.seq;
    const model = await this.buildModel();
    // A newer refresh started meanwhile, or the view went away.
    if (mine !== this.seq || !this.view) return;
    void this.view.webview.postMessage({ type: 'state', model, strings: panelStrings() });
  }
}
