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
      for (const m of src.matchAll(/l10n\.t\(\s*(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
        const text = new Function(`return ${m[1]}${m[2]}${m[1]}`)() as string;
        found++;
        assert.ok(text in bundle, `bundle.l10n.tr.json is missing: ${text} (${f})`);
      }
    }
    assert.ok(found > 10);
  });

  it('every contributed command is registered in src/extension.ts', () => {
    const ext = readFileSync(join(ROOT, 'src/extension.ts'), 'utf8');
    const ids = pkg.contributes.commands.map((c: any) => c.command);
    assert.equal(ids.length, 5);
    for (const id of ids) assert.ok(ext.includes(`'${id}'`) || ext.includes(`"${id}"`), id);
  });
});
