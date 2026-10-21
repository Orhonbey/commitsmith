import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCli, findOnPath } from './exec';
import { AiError, AiTool, ModelInfo, RunOptions } from './types';

function compareVersions(a: string, b: string): number {
  const pa = a.match(/\d+/g)?.map(Number) ?? [];
  const pb = b.match(/\d+/g)?.map(Number) ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

function installedCandidates(): string[] {
  const local = process.env.LOCALAPPDATA;
  if (process.platform !== 'win32' || !local) return [];
  const bin = join(local, 'OpenAI', 'Codex', 'bin');
  const found = [join(bin, 'codex.exe')];
  try {
    for (const e of readdirSync(bin, { withFileTypes: true })) {
      if (e.isDirectory()) found.push(join(bin, e.name, 'codex.exe'));
    }
  } catch {
    /* no install dir */
  }
  return found.filter((p) => existsSync(p));
}

export function createCodexTool(env: { exeOverride?: string; codexHome?: string } = {}): AiTool {
  // Version probing spawns one process per install; do it once per tool instance.
  let installed: Promise<string | undefined> | undefined;
  const detect = async (): Promise<string | undefined> => {
    if (env.exeOverride !== undefined) return existsSync(env.exeOverride) ? env.exeOverride : undefined;
    const onPath = findOnPath('codex');
    if (onPath) return onPath;
    return (installed ??= pickInstalled());
  };
  const pickInstalled = async (): Promise<string | undefined> => {
    const found = installedCandidates();
    if (found.length <= 1) return found[0];
    const versions = await Promise.all(
      found.map(async (p) => {
        try {
          const { stdout } = await execCli(p, ['--version'], '', { cwd: tmpdir(), timeoutMs: 10000 });
          return { p, v: stdout };
        } catch {
          return { p, v: '0' };
        }
      }),
    );
    versions.sort((a, b) => compareVersions(b.v, a.v));
    return versions[0].p;
  };

  return {
    id: 'codex',
    displayName: 'Codex',
    detect,
    async listModels(extra: string[]): Promise<ModelInfo[]> {
      const home = env.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
      try {
        const cache = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8'));
        const models: ModelInfo[] = (cache.models ?? [])
          .filter((m: any) => m && m.visibility === 'list' && typeof m.slug === 'string')
          .map((m: any) => ({ id: m.slug, label: m.display_name || m.slug }));
        if (models.length) return models;
      } catch {
        /* fall back to the configured list */
      }
      return extra.map((id) => ({ id, label: id }));
    },
    async run(prompt: string, opts: RunOptions): Promise<string> {
      const exe = await detect();
      if (!exe) throw new AiError('notFound', 'Codex was not found');
      const tmp = await mkdtemp(join(tmpdir(), 'commitsmith-codex-'));
      try {
        const outFile = join(tmp, 'answer.txt');
        const args = [
          'exec',
          '-m',
          opts.model,
          '-s',
          'read-only',
          '--ephemeral',
          '--skip-git-repo-check',
          '-C',
          opts.cwd,
          '-o',
          outFile,
        ];
        if (opts.jsonSchema) {
          const schemaFile = join(tmp, 'schema.json');
          await writeFile(schemaFile, JSON.stringify(opts.jsonSchema));
          args.push('--output-schema', schemaFile);
        }
        args.push('-');
        await execCli(exe, args, prompt, opts);
        let text: string;
        try {
          text = await readFile(outFile, 'utf8');
        } catch {
          throw new AiError('badOutput', 'Codex wrote no answer file');
        }
        if (opts.jsonSchema) {
          try {
            JSON.parse(text);
          } catch {
            throw new AiError('badOutput', 'Codex did not return JSON', text.slice(-2000));
          }
        }
        return text;
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
  };
}
