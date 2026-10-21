import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'mocha';

const ROOT = resolve(__dirname, '../..');
const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const pkg = readJson('package.json');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('manifest', () => {
  const nls = { en: readJson('package.nls.json'), tr: readJson('package.nls.tr.json') };

  it('every %key% in package.json exists in both nls files', () => {
    const keys = [...JSON.stringify(pkg).matchAll(/"%([^%"]+)%"/g)].map((m) => m[1]);
    assert.ok(keys.length > 10);
    for (const k of keys) {
      assert.ok(k in nls.en, `package.nls.json is missing ${k}`);
      assert.ok(k in nls.tr, `package.nls.tr.json is missing ${k}`);
    }
  });

  it('commands and settings use only localized titles and descriptions', () => {
    for (const c of pkg.contributes.commands) assert.match(c.title, /^%.+%$/, c.command);
    for (const [k, v] of Object.entries<any>(pkg.contributes.configuration.properties)) {
      assert.match(v.description ?? v.markdownDescription ?? '', /^%.+%$/, k);
    }
  });

  it('every vscode.l10n.t literal has a Turkish translation', () => {
    const bundle = readJson('l10n/bundle.l10n.tr.json');
    const files = walk(join(ROOT, 'src')).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
    let found = 0;
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/l10n\.t\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)) {
        const text = new Function(`return ${m[1] !== undefined ? `'${m[1]}'` : `"${m[2]}"`}`)() as string;
        found++;
        assert.ok(text in bundle, `bundle.l10n.tr.json is missing: ${text} (${f})`);
      }
    }
    assert.ok(found > 10);
  });

  it('every string key the plan webview asks for is supplied (localized) by the extension', () => {
    const js = readFileSync(join(ROOT, 'media/plan.js'), 'utf8');
    const panel = readFileSync(join(ROOT, 'src/vscode/planPanel.ts'), 'utf8');
    const supplied = new Set([...panel.matchAll(/^\s+(\w+): vscode\.l10n\.t\(/gm)].map((m) => m[1]));
    const used = new Set([...js.matchAll(/\bS\('(\w+)'\)/g)].map((m) => m[1]));
    assert.ok(used.size > 10);
    for (const k of used) assert.ok(supplied.has(k), `media/plan.js uses S('${k}') but planPanel.ts does not supply it`);
  });


  it('every string key the panel webview asks for is supplied (localized) by the extension', () => {
    const js = readFileSync(join(ROOT, 'media/panel.js'), 'utf8');
    const side = readFileSync(join(ROOT, 'src/vscode/sidePanel.ts'), 'utf8');
    const supplied = new Set([...side.matchAll(/^\s+(\w+): vscode\.l10n\.t\(/gm)].map((m) => m[1]));
    const used = new Set([...js.matchAll(/\bS\('(\w+)'\)/g)].map((m) => m[1]));
    assert.ok(used.size > 15);
    assert.ok(js.includes("type: 'setMessage'"), 'the webview writes the message back');
    for (const k of used) assert.ok(supplied.has(k), `media/panel.js uses S('${k}') but sidePanel.ts does not supply it`);
    for (const k of supplied) assert.ok(used.has(k), `sidePanel.ts supplies ${k} but media/panel.js never uses it`);
  });

  it('media/panel.js holds no English text: only symbols, class names and message ids', () => {
    const js = readFileSync(join(ROOT, 'media/panel.js'), 'utf8');
    // Visible text is built from S(...) or from data; a quoted sentence or capitalised word would be English copy.
    for (const m of js.matchAll(/'([A-Z][a-z]+[^']*)'/g)) assert.fail(`English literal in media/panel.js: ${m[1]}`);
    for (const m of js.matchAll(/'([a-z]+ [a-z]+ [a-z]+[^']*)'/g)) assert.fail(`English literal in media/panel.js: ${m[1]}`);
  });

  it('contributes the Activity Bar container with the panel, changes and recent views, localized', () => {
    const bar = pkg.contributes.viewsContainers.activitybar;
    assert.equal(bar.length, 1);
    assert.equal(bar[0].id, 'commitsmith');
    assert.match(bar[0].title, /^%.+%$/);
    assert.equal(bar[0].icon, 'media/activity.svg');
    const views = pkg.contributes.views.commitsmith;
    assert.deepEqual(views.map((v: any) => v.id), ['commitsmith.panel', 'commitsmith.changes', 'commitsmith.recent']);
    assert.equal(views[0].type, 'webview');
    assert.equal(views[1].type, undefined, 'the changes view is a native tree');
    assert.equal(views[2].visibility, 'collapsed', 'Recent starts collapsed');
    for (const v of views) assert.match(v.name, /^%.+%$/);
    const svg = readFileSync(join(ROOT, 'media/activity.svg'), 'utf8');
    assert.ok(svg.includes('currentColor'));
    assert.ok(!/#[0-9a-fA-F]{3,6}/.test(svg), 'the icon has no fixed colours');
  });

  it('the welcome texts of the trees are localized', () => {
    const w = pkg.contributes.viewsWelcome;
    assert.ok(w.some((x: any) => x.view === 'commitsmith.recent'));
    assert.ok(w.some((x: any) => x.view === 'commitsmith.changes'));
    for (const x of w) assert.match(x.contents, /^%.+%$/);
  });

  it('the file actions are inline icons per item kind, and new files never offer discard', () => {
    const menu: any[] = pkg.contributes.menus['view/item/context'];
    const has = (command: string, viewItem: string, inline: boolean) =>
      menu.some((m) => m.command === 'commitsmith.' + command && m.when.includes('viewItem == ' + viewItem) && m.group.startsWith('inline') === inline);
    assert.ok(has('unstage', 'file.staged', true));
    assert.ok(has('stage', 'file.changes', true) && has('discard', 'file.changes', true) && has('openFile', 'file.changes', true));
    assert.ok(has('stage', 'file.new', true) && has('openFile', 'file.new', true));
    for (const m of menu) assert.ok(!(m.command === 'commitsmith.discard' && m.when.includes('file.new')), 'no discard on new files');
    assert.ok(has('unstageAll', 'group.staged', true) && has('stageAll', 'group.changes', true) && has('discardAll', 'group.changes', true) && has('stageAll', 'group.untracked', true));
    assert.ok(!menu.some((m) => m.command === 'commitsmith.discardAll' && m.when.includes('group.untracked')));
    for (const m of menu) assert.ok(m.when.includes('view == commitsmith.changes'));
    const icons = Object.fromEntries(pkg.contributes.commands.map((c: any) => [c.command, c.icon]));
    assert.equal(icons['commitsmith.stage'], '$(add)');
    assert.equal(icons['commitsmith.unstage'], '$(remove)');
    assert.equal(icons['commitsmith.discard'], '$(discard)');
    assert.equal(icons['commitsmith.openFile'], '$(go-to-file)');
  });

  it('the changes tree has a Refresh action in its title', () => {
    const t: any[] = pkg.contributes.menus['view/title'];
    assert.ok(t.some((m) => m.command === 'commitsmith.refreshChanges' && m.when.includes('commitsmith.changes') && m.group === 'navigation'));
  });

  it('the item commands stay out of the Command Palette', () => {
    const hidden = new Set(pkg.contributes.menus.commandPalette.filter((m: any) => m.when === 'false').map((m: any) => m.command));
    for (const id of ['refreshChanges', 'stage', 'unstage', 'discard', 'stageAll', 'unstageAll', 'discardAll', 'openFile', 'copyPath', 'openChange', 'copySha']) {
      assert.ok(hidden.has('commitsmith.' + id), id);
    }
  });

  it('the package version is 0.3.0', () => {
    assert.equal(pkg.version, '0.3.0');
  });

  it('every contributed command is registered in src/extension.ts', () => {
    const ext = readFileSync(join(ROOT, 'src/extension.ts'), 'utf8');
    const ids = pkg.contributes.commands.map((c: any) => c.command);
    assert.equal(ids.length, 16);
    for (const id of ids) assert.ok(ext.includes(`'${id}'`) || ext.includes(`"${id}"`), id);
  });
});
