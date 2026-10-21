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

const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '-M'];
const FETCH_PARALLELISM = 8;

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
  let base: string[] = [];
  if (tracked.length > 0) {
    base = await diffBase(root, scope.kind);
    const ns = await runGit(root, [...base, ...DIFF_FLAGS, '--numstat', '-z']);
    for (const [k, v] of parseNumstat(ns.stdout)) numstat.set(k, v);
  }
  const summaryExt = new Set(opts.summaryOnlyExtensions.map((e) => e.toLowerCase()));
  const toFetch: FileDiff[] = [];

  const out: FileDiff[] = [];
  for (const f of scope.files) {
    const sizeBytes = await sizeOf(root, f.path, f.change);
    const common = { path: f.path, origPath: f.origPath, change: f.change, isNew: f.isNew, sizeBytes };
    if (isUntracked(f)) {
      let buf: Buffer;
      try {
        buf = await readFile(join(root, f.path));
      } catch {
        buf = Buffer.alloc(0);
      }
      if (looksBinary(buf)) {
        out.push({ ...common, binary: true, added: 0, removed: 0, summarized: true });
      } else {
        const { patch, lines } = newFilePatch(f.path, buf.toString('utf8'));
        out.push({ ...common, binary: false, added: lines, removed: 0, patch, summarized: false });
      }
      continue;
    }
    const n = numstat.get(f.path) ?? { added: 0, removed: 0, binary: false };
    const entry: FileDiff = {
      ...common,
      binary: n.binary,
      added: n.added,
      removed: n.removed,
      summarized: n.binary,
    };
    // Every patch line costs at least 2 bytes, so this is a cheap lower bound on the patch size.
    const tooBig = (n.added + n.removed) * 2 > opts.maxFileDiffBytes;
    if (n.binary || tooBig || summaryExt.has(extname(f.path).toLowerCase())) entry.summarized = true;
    else toFetch.push(entry);
    out.push(entry);
  }

  // One path per git call, a few at a time: summarized files never cost a patch fetch.
  let next = 0;
  const worker = async () => {
    while (next < toFetch.length) {
      const d = toFetch[next++];
      const paths = d.origPath ? [d.origPath, d.path] : [d.path];
      try {
        d.patch = (await runGit(root, [...base, ...DIFF_FLAGS, '--', ...paths])).stdout;
      } catch {
        d.summarized = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(FETCH_PARALLELISM, toFetch.length) }, worker));
  const drop = (d: FileDiff) => {
    d.patch = undefined;
    d.summarized = true;
  };
  for (const d of out) {
    if (d.patch === undefined) continue;
    if (Buffer.byteLength(d.patch) > opts.maxFileDiffBytes) drop(d);
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
