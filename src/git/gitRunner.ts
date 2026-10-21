import { spawn } from 'node:child_process';

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly code: number,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${code}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

export interface RunGitOptions {
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  allowFail?: boolean;
  /**
   * Read-only command: GIT_OPTIONAL_LOCKS=0, so it never takes index.lock to refresh the index, and
   * LC_ALL=C for stable output. Other commands (commit runs the user's hooks) keep the user's env.
   */
  readOnly?: boolean;
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
  code: number;
}

const MAX_BUFFER = 64 * 1024 * 1024;

export function runGit(cwd: string, args: string[], opts: RunGitOptions = {}): Promise<RunGitResult> {
  const fullArgs = ['-c', 'core.quotePath=false', ...args];
  // No GIT_LITERAL_PATHSPECS here: it would leak into hooks. Our own pathspecs use `literal()`.
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env };
  if (opts.readOnly) Object.assign(env, { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' });
  // An explicit `undefined` in opts.env removes the inherited variable.
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return new Promise((resolve, reject) => {
    const child = spawn('git', fullArgs, {
      cwd,
      env,
      windowsHide: true,
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let overflow = false;
    const collect = (bucket: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BUFFER) {
        overflow = true;
        child.kill();
        return;
      }
      bucket.push(chunk);
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (overflow) {
        reject(new GitError(args, -1, 'git output exceeded the 64 MB buffer'));
        return;
      }
      const exit = code ?? -1;
      if (exit !== 0 && !opts.allowFail) {
        reject(new GitError(args, exit, stderr));
        return;
      }
      resolve({ stdout, stderr, code: exit });
    });
    child.stdin.end(opts.input);
  });
}

/** A path as a pathspec that matches only itself (no glob or other pathspec magic). */
export const literal = (path: string): string => `:(literal)${path}`;

/** NUL-joined literal pathspecs for `--pathspec-from-file=- --pathspec-file-nul`. */
export function pathspecInput(paths: string[]): string {
  return paths.map((p) => literal(p) + '\0').join('');
}

/** NUL-joined plain paths, for commands that read paths rather than pathspecs (`update-index -z --stdin`). */
export function pathListInput(paths: string[]): string {
  return paths.map((p) => p + '\0').join('');
}
