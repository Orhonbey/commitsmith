import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { collectDiff, DEFAULT_DIFF_OPTIONS, type DiffOptions } from '../../src/git/diffCollector';
import { readStatus } from '../../src/git/status';
import { resolveScope, type Scope } from '../../src/git/scope';
import { createTempRepo, type TempRepo } from '../helpers/tempRepo';

const manual = (kind: Scope['kind'], paths: string[]): Scope => ({
  kind,
  files: paths.map((path) => ({ path, change: 'modified', isNew: false })),
  leftOutUntracked: [],
});

describe('diffCollector', () => {
  let repo: TempRepo;
  afterEach(async () => {
    await repo.cleanup();
  });

  it('staged diff ignores unstaged edits', async () => {
    repo = await createTempRepo({ 'a.txt': 'base\n' });
    repo.write('a.txt', 'base\none\n');
    await repo.git('add', 'a.txt');
    repo.write('a.txt', 'base\none\ntwo\n');
    const [d] = await collectDiff(repo.root, manual('staged', ['a.txt']), DEFAULT_DIFF_OPTIONS);
    assert.ok(d.patch!.includes('+one'));
    assert.ok(!d.patch!.includes('+two'));
    assert.equal(d.added, 1);
  });

  it('summary-only extension has no patch', async () => {
    repo = await createTempRepo({ 'x.asset': 'a\nb\n' });
    repo.write('x.asset', 'a\nc\nd\n');
    const [d] = await collectDiff(repo.root, manual('all', ['x.asset']), DEFAULT_DIFF_OPTIONS);
    assert.equal(d.patch, undefined);
    assert.equal(d.summarized, true);
    assert.equal(d.added, 2);
    assert.equal(d.removed, 1);
  });

  it('binary detected', async () => {
    repo = await createTempRepo({ 'img.bin': Buffer.from([0, 1, 2]) });
    repo.write('img.bin', randomBytes(1024));
    const [d] = await collectDiff(repo.root, manual('all', ['img.bin']), DEFAULT_DIFF_OPTIONS);
    assert.equal(d.binary, true);
    assert.equal(d.patch, undefined);
    assert.equal(d.sizeBytes, 1024);
  });

  it('file over maxFileDiffBytes is summarized', async () => {
    const lines = (p: string) => Array.from({ length: 50 }, (_, i) => `${p}${i}\n`).join('');
    repo = await createTempRepo({ 'big.txt': lines('old') });
    repo.write('big.txt', lines('new'));
    const opts: DiffOptions = { ...DEFAULT_DIFF_OPTIONS, maxFileDiffBytes: 100 };
    const [d] = await collectDiff(repo.root, manual('all', ['big.txt']), opts);
    assert.equal(d.summarized, true);
    assert.equal(d.patch, undefined);
    assert.equal(d.added, 50);
    assert.equal(d.removed, 50);
  });

  it('total cap summarizes largest first', async () => {
    repo = await createTempRepo({ 'a.txt': 'x\n', 'b.txt': 'x\n', 'c.txt': 'x\n' });
    repo.write('a.txt', 'x\n' + 'a'.repeat(300) + '\n');
    repo.write('b.txt', 'x\n' + 'b'.repeat(200) + '\n');
    repo.write('c.txt', 'x\n' + 'c'.repeat(100) + '\n');
    const scope = manual('all', ['a.txt', 'b.txt', 'c.txt']);
    const all = await collectDiff(repo.root, scope, { ...DEFAULT_DIFF_OPTIONS, maxTotalBytes: 1e9 });
    const len = (p: string) => Buffer.byteLength(all.find((f) => f.path === p)!.patch!);
    const cap = len('b.txt') + len('c.txt');
    const capped = await collectDiff(repo.root, scope, { ...DEFAULT_DIFF_OPTIONS, maxTotalBytes: cap });
    const by = (p: string) => capped.find((f) => f.path === p)!;
    assert.equal(by('a.txt').summarized, true);
    assert.equal(by('a.txt').patch, undefined);
    assert.ok(by('b.txt').patch);
    assert.ok(by('c.txt').patch);
  });

  it('600 files stay under the command line limit', async function () {
    this.timeout(120_000);
    const names = Array.from({ length: 600 }, (_, i) => `d/${'n'.repeat(110)}${String(i).padStart(4, '0')}.txt`);
    repo = await createTempRepo(Object.fromEntries(names.map((n) => [n, 'a\n'])));
    for (const n of names) repo.write(n, 'a\nb\n');
    const out = await collectDiff(repo.root, manual('all', names), DEFAULT_DIFF_OPTIONS);
    assert.equal(out.length, 600);
    assert.ok(out.every((f) => f.added === 1));
  });

  it('keeps spaces and non-ASCII paths, and renames', async () => {
    repo = await createTempRepo({ 'Oswald-Medium SDF.asset': 'a\n', 'Ödeme.cs': 'class A {}\nline\nline2\nline3\n' });
    await repo.git('mv', 'Ödeme.cs', 'Ödeme2.cs');
    repo.write('Ödeme2.cs', 'class A {}\nline\nline2\nline3\nmore\n');
    await repo.git('add', '-A');
    repo.write('Oswald-Medium SDF.asset', 'b\n');
    const scope = resolveScope(await readStatus(repo.root), { includeUntracked: false });
    assert.equal(scope.kind, 'staged');
    const out = await collectDiff(repo.root, scope, DEFAULT_DIFF_OPTIONS);
    assert.equal(out.length, 1);
    assert.equal(out[0].path, 'Ödeme2.cs');
    assert.equal(out[0].origPath, 'Ödeme.cs');
    assert.equal(out[0].change, 'renamed');
    assert.equal(out[0].added, 1);
    assert.ok(out[0].patch!.includes('+more'));
  });

  it('untracked text and binary files', async () => {
    repo = await createTempRepo({ 'a.txt': 'a\n' });
    repo.write('new file.txt', 'l1\nl2\nl3');
    repo.write('blob.dat', Buffer.from([1, 0, 2]));
    const scope = resolveScope(await readStatus(repo.root), { includeUntracked: true });
    const out = await collectDiff(repo.root, scope, DEFAULT_DIFF_OPTIONS);
    const t = out.find((f) => f.path === 'new file.txt')!;
    assert.equal(t.added, 3);
    assert.equal(t.removed, 0);
    assert.equal(t.isNew, true);
    assert.equal(t.sizeBytes, 8);
    assert.ok(t.patch!.includes('+l3'));
    const b = out.find((f) => f.path === 'blob.dat')!;
    assert.equal(b.binary, true);
    assert.equal(b.patch, undefined);
  });

  it('deleted files and repos without HEAD', async () => {
    repo = await createTempRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
    await repo.git('rm', 'a.txt');
    const del = await collectDiff(
      repo.root,
      { kind: 'staged', files: [{ path: 'a.txt', change: 'deleted', isNew: false }], leftOutUntracked: [] },
      DEFAULT_DIFF_OPTIONS,
    );
    assert.equal(del[0].sizeBytes, 0);
    assert.equal(del[0].removed, 1);
    await repo.cleanup();

    repo = await createTempRepo();
    repo.write('n.txt', 'hello\n');
    await repo.git('add', 'n.txt');
    const out = await collectDiff(
      repo.root,
      { kind: 'all', files: [{ path: 'n.txt', change: 'added', isNew: false }], leftOutUntracked: [] },
      DEFAULT_DIFF_OPTIONS,
    );
    assert.equal(out[0].added, 1);
    assert.ok(out[0].patch!.includes('+hello'));
  });
});
