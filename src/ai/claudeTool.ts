import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execCli, findOnPath } from './exec';
import { AiError, AiTool, ModelInfo, RunOptions } from './types';

const BUILT_IN: ModelInfo[] = [
  { id: 'haiku', label: 'Haiku', detail: 'fastest' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus', detail: 'most capable' },
];

function candidates(): string[] {
  const home = homedir();
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [join(home, '.local', 'bin'), join(home, '.claude', 'local')];
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'));
  return dirs.flatMap((d) => names.map((n) => join(d, n)));
}

export function createClaudeTool(env: { exeOverride?: string } = {}): AiTool {
  const detect = async (): Promise<string | undefined> => {
    if (env.exeOverride !== undefined) return existsSync(env.exeOverride) ? env.exeOverride : undefined;
    return findOnPath('claude') ?? candidates().find((p) => existsSync(p));
  };

  return {
    id: 'claude',
    displayName: 'Claude Code',
    detect,
    async listModels(extra: string[]): Promise<ModelInfo[]> {
      const seen = new Set(BUILT_IN.map((m) => m.id));
      const more = extra.filter((id) => id && !seen.has(id) && seen.add(id)).map((id) => ({ id, label: id }));
      return [...BUILT_IN, ...more];
    },
    async run(prompt: string, opts: RunOptions): Promise<string> {
      const exe = await detect();
      if (!exe) throw new AiError('notFound', 'Claude Code was not found');
      const args = [
        '-p',
        '--model',
        opts.model,
        '--output-format',
        'json',
        '--tools',
        '',
        '--strict-mcp-config',
        '--no-session-persistence',
        '--setting-sources',
        'project',
      ];
      if (opts.jsonSchema) args.push('--json-schema', JSON.stringify(opts.jsonSchema));
      const { stdout } = await execCli(exe, args, prompt, opts);
      let parsed: any;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        throw new AiError('badOutput', 'Claude Code did not return JSON', stdout.slice(-2000));
      }
      if (!parsed || typeof parsed !== 'object') throw new AiError('badOutput', 'Unexpected Claude Code output', stdout);
      if (parsed.is_error) {
        throw new AiError('exit', 'Claude Code reported an error', String(parsed.result ?? stdout));
      }
      if (opts.jsonSchema) {
        const so = parsed.structured_output;
        if (so && typeof so === 'object') return JSON.stringify(so);
        if (typeof parsed.result === 'string') {
          try {
            JSON.parse(parsed.result);
            return parsed.result;
          } catch {
            /* fall through */
          }
        }
        throw new AiError('badOutput', 'Claude Code returned no structured output', stdout);
      }
      if (typeof parsed.result !== 'string') throw new AiError('badOutput', 'Claude Code returned no result', stdout);
      return parsed.result;
    },
  };
}
