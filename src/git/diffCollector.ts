import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { runGit } from './gitRunner';
import type { Scope, ScopedFile } from './scope';

export type DiffOptions = {
  summaryOnlyExtensions: string[];
  maxFileDiffBytes: number;
  maxTotalBytes: number;
};

export const DEFAULT_DIFF_OPTIONS: DiffOptions = {
  summaryOnlyExtensions: [
    '.asset', '.prefab', '.unity', '.meta', '.mat', '.anim', '.controller',
    '.png', '.jpg', '.jpeg', '.psd', '.tga', '.exr',
    '.wav', '.mp3', '.ogg', '.fbx', '.ttf', '.otf', '.zip', '.dll',
  ],
  maxFileDiffBytes: 200_000,
  maxTotalBytes: 400_000,
};

export type FileDiff = {
  path: string;
  origPath?: string;
  change: ScopedFile['change'];
  isNew: boolean;
  binary: boolean;
  sizeBytes: number;
  added: number;
  removed: number;
  patch?: string;
  summarized: boolean;
};

type Numstat = { added: number; removed: number; binary: boolean };

async function emptyTreeSha(root: string): Promise<string> {
  const r = await runGit(root, ['hash-object', '-t', 'tree', '--stdin'], { input: '' });
  return r.stdout.trim();
}

async function diffBase(root: string, kind: Scope['kind']): Promise<string[]> {
  if (kind === 'staged') return ['diff', '--cached'];
  const head = await runGit(root, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
  return head.code === 0 ? ['diff', 'HEAD'] : ['diff', await emptyTreeSha(root)];
}

/** Parses `git diff --numstat -z`; keyed by the new path. */
function parseNumstat(out: string): Map<string, Numstat> {
  const map = new Map<string, Numstat>();
  const parts = out.split('\0');
  let i = 0;
  while (i < parts.length) {
    const rec = parts[i++];
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
    if (!m) continue;
    let path = m[3];
    if (path === '') {
      i++; // old path of a rename
      path = parts[i++];
    }
    const binary = m[1] === '-';
    map.set(path, { binary, added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]) });
  }
  return map;
}

/** Splits a multi-file patch on `diff --git` headers. */
function splitPatch(out: string): { header: string; text: string }[] {
  const chunks: { header: string; text: string }[] = [];
  const starts: number[] = [];
  const re = /^diff --git /gm;
  for (let m = re.exec(out); m; m = re.exec(out)) starts.push(m.index);
  starts.forEach((s, i) => {
    const text = out.slice(s, starts[i + 1] ?? out.length);
    chunks.push({ header: text.slice('diff --git '.length, text.indexOf('\n')), text });
  });
  return chunks;
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function newFilePatch(path: string, content: string): { patch: string; lines: number } {
  if (content === '') {
    return { patch: `diff --git a/${path} b/${path}\nnew file mode 100644\n`, lines: 0 };
  }
  const endsWithNl = content.endsWith('\n');
  const lines = (endsWithNl ? content.slice(0, -1) : content).split('\n');
  let patch =
    `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n` +
    `@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((l) => '+' + l).join('\n') +
    '\n';
  if (!endsWithNl) patch += '\ No newline at end of file\n';
  return { patch, lines: lines.length };
}

async function sizeOf(root: string, path: string, change: ScopedFile['change']): Promise<number> {
  if (change === 'deleted') return 0;
  try {
    return (await stat(join(root, path))).size;
  } catch {
    return 0;
  }
}

export async function collectDiff(root: string, scope: Scope, opts: DiffOptions): Promise<FileDiff[]> {
  const isUntracked = (f: ScopedFile) => scope.kind === 'all' && f.isNew && f.change === 'added';
  const tracked = scope.files.filter((f) => !isUntracked(f));

  const numstat = new Map<string, Numstat>();
  const patches = new Map<string, string>();
  if (tracked.length > 0) {
    // `git diff` has no --pathspec-from-file; the scope already covers every staged/changed file,
    // so diff the whole index/worktree (no file list on the command line) and pick scoped files out.
    const base = await diffBase(root, scope.kind);
    const common = ['--no-color', '--no-ext-diff', '-M'];
    const ns = await runGit(root, [...base, ...common, '--numstat', '-z']);
    for (const [k, v] of parseNumstat(ns.stdout)) numstat.set(k, v);
    const pt = await runGit(root, [...base, ...common]);
    for (const chunk of splitPatch(pt.stdout)) patches.set(chunk.header, chunk.text);
  }

  const out: FileDiff[] = [];
  for (const f of scope.files) {
    const sizeBytes = await sizeOf(root, f.path, f.change);
    const base = { path: f.path, origPath: f.origPath, change: f.change, isNew: f.isNew, sizeBytes };
    if (isUntracked(f)) {
      let buf: Buffer;
      try {
        buf = await readFile(join(root, f.path));
      } catch {
        buf = Buffer.alloc(0);
      }
      if (looksBinary(buf)) {
        out.push({ ...base, binary: true, added: 0, removed: 0, summarized: true });
      } else {
        const { patch, lines } = newFilePatch(f.path, buf.toString('utf8'));
        out.push({ ...base, binary: false, added: lines, removed: 0, patch, summarized: false });
      }
      continue;
    }
    const n = numstat.get(f.path) ?? { added: 0, removed: 0, binary: false };
    const header = `a/${f.origPath ?? f.path} b/${f.path}`;
    out.push({
      ...base,
      binary: n.binary,
      added: n.added,
      removed: n.removed,
      patch: n.binary ? undefined : patches.get(header),
      summarized: n.binary,
    });
  }

  const summaryExt = new Set(opts.summaryOnlyExtensions.map((e) => e.toLowerCase()));
  const drop = (d: FileDiff) => {
    d.patch = undefined;
    d.summarized = true;
  };
  for (const d of out) {
    if (d.patch === undefined) continue;
    if (summaryExt.has(extname(d.path).toLowerCase()) || Buffer.byteLength(d.patch) > opts.maxFileDiffBytes) drop(d);
  }
  const withPatch = out
    .filter((d) => d.patch !== undefined)
    .sort((a, b) => Buffer.byteLength(b.patch!) - Buffer.byteLength(a.patch!));
  let total = withPatch.reduce((s, d) => s + Buffer.byteLength(d.patch!), 0);
  for (const d of withPatch) {
    if (total <= opts.maxTotalBytes) break;
    total -= Buffer.byteLength(d.patch!);
    drop(d);
  }
  return out;
}
