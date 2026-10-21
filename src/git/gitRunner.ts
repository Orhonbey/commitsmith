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
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
  code: number;
}

const MAX_BUFFER = 64 * 1024 * 1024;

export function runGit(cwd: string, args: string[], opts: RunGitOptions = {}): Promise<RunGitResult> {
  const fullArgs = ['-c', 'core.quotePath=false', ...args];
  const env: NodeJS.ProcessEnv = { ...process.env, ...opts.env, GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' };
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

/** NUL-joined path list for `--pathspec-from-file=- --pathspec-file-nul`. */
export function pathspecInput(paths: string[]): string {
  return paths.map((p) => p + '\0').join('');
}
