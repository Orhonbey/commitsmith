import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { readStatus } from '../git/status';
import { readPushInfo } from '../push/push';
import type { Activity } from './activity';
import type { CommitSmithCommands } from './commands';
import { getApi } from './gitApi';
import { PanelModel, buildPanelModel } from './panelModel';
import type { ToolPicker } from './statusBar';

export const PANEL_VIEW_ID = 'commitsmith.panel';

/** The only actions the panel may run; anything else from the webview is dropped. */
export const PANEL_ACTIONS = ['writeMessage', 'writeAndCommit', 'smartSplit', 'push'] as const;
export type PanelAction = (typeof PANEL_ACTIONS)[number];

export type PanelMessage =
  | { type: 'ready' }
  | { type: 'pickModel' }
  | { type: 'run'; action: PanelAction }
  | { type: 'selectRepo'; root: string };

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
    scopeTitle: vscode.l10n.t('What will be looked at'),
    staged: vscode.l10n.t('Staged ({0})'),
    all: vscode.l10n.t('All ({0})'),
    leftOut: vscode.l10n.t('{0} new files are not included'),
    writeMessage: vscode.l10n.t('Write message'),
    writeAndCommit: vscode.l10n.t('Write + Commit'),
    smartSplit: vscode.l10n.t('Smart split'),
    push: vscode.l10n.t('Push'),
    working: vscode.l10n.t('working…'),
    pushUpstream: vscode.l10n.t('{0} · {1} commits to push'),
    pushNoUpstream: vscode.l10n.t('no upstream · {0} commits to push'),
    noRemote: vscode.l10n.t('This repository has no remote to push to'),
    unborn: vscode.l10n.t('Nothing to push yet. Make a first commit'),
    detached: vscode.l10n.t('Not on a branch'),
    recent: vscode.l10n.t('Recent'),
    nothingYet: vscode.l10n.t('Nothing yet'),
    recentCommitted: vscode.l10n.t('Committed {0} {1}'),
    recentPushed: vscode.l10n.t('Pushed {0}'),
    noRepo: vscode.l10n.t('No Git repository is open'),
  };
}

/** The Activity Bar view: a small control panel for the selected repository. */
export class SidePanel implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private selected: string | undefined;
  private roots: string[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private readonly subs: vscode.Disposable[] = [];
  private readonly repoSubs = new Map<string, vscode.Disposable>();
  /** Counts resolveWebviewView calls (extension tests check the provider was reached). */
  resolved = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly commands: CommitSmithCommands,
    private readonly picker: ToolPicker,
    private readonly activity: Activity,
  ) {
    const changed = () => this.schedule();
    this.subs.push(
      picker.onDidChange(changed),
      activity.onDidChange(changed),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('commitsmith')) changed();
      }),
    );
    void this.watchRepositories();
  }

  private async watchRepositories(): Promise<void> {
    const api = await getApi();
    if (!api) return;
    const sync = () => {
      const open = new Map(api.repositories.map((r) => [r.rootUri.fsPath, r]));
      for (const [root, sub] of this.repoSubs) {
        if (!open.has(root)) {
          sub.dispose();
          this.repoSubs.delete(root);
        }
      }
      for (const [root, repo] of open) {
        if (!this.repoSubs.has(root)) this.repoSubs.set(root, repo.state.onDidChange(() => this.schedule()));
      }
      this.schedule();
    };
    this.subs.push(api.onDidOpenRepository(sync), api.onDidCloseRepository(sync));
    sync();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const s of [...this.subs, ...this.repoSubs.values()]) s.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.resolved++;
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((raw: unknown) => void this.handle(raw));
    view.onDidChangeVisibility(() => {
      if (view.visible) this.schedule(0);
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
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
        this.selected = msg.root;
        await this.refresh();
        break;
      case 'run': {
        const root = this.selected ?? this.roots[0];
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
    if (!this.selected || !this.roots.includes(this.selected)) this.selected = this.roots[0];
    const root = this.selected;
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
      recent: this.activity.recent(),
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
