import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { AiError } from './types';

const MAX_BUFFER = 64 * 1024 * 1024;

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

const isWin = process.platform === 'win32';

/** Quote one argument for a `.cmd` shim run through `cmd.exe /d /s /c` (escaped twice: cmd re-parses `%*`). */
function quoteForCmd(arg: string): string {
  let a = arg.replace(/(\\*)"/g, '$1$1\\"');
  a = a.replace(/(\\*)$/, '$1$1');
  a = `"${a}"`;
  return escMeta(escMeta(a));
}

const escMeta = (s: string) => s.replace(/[()%!^"<>&|;, ]/g, '^$&');

function killTree(pid: number | undefined, useGroup: boolean): void {
  if (pid === undefined) return;
  if (isWin) {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try {
    process.kill(useGroup ? -pid : pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

export function execCli(
  exe: string,
  args: string[],
  stdin: string,
  opts: ExecOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new AiError('cancelled', 'Cancelled'));
      return;
    }
    const viaCmd = isWin && /\.(cmd|bat)$/i.test(exe);
    const child = viaCmd
      ? spawn(
          process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', `"${[escMeta(exe), ...args.map(quoteForCmd)].join(' ')}"`],
          { cwd: opts.cwd, windowsHide: true, windowsVerbatimArguments: true },
        )
      : spawn(exe, args, { cwd: opts.cwd, windowsHide: true, detached: !isWin });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const stderrText = () => Buffer.concat(err).toString('utf8');
    const abortWith = (kind: 'timeout' | 'cancelled', msg: string) => {
      killTree(child.pid, !isWin);
      finish(() => reject(new AiError(kind, msg, stderrText())));
    };
    const onAbort = () => abortWith('cancelled', 'Cancelled');

    timer = setTimeout(() => abortWith('timeout', `Timed out after ${opts.timeoutMs} ms`), opts.timeoutMs);
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const collect = (bucket: Buffer[]) => (d: Buffer) => {
      size += d.length;
      if (size > MAX_BUFFER) {
        killTree(child.pid, !isWin);
        finish(() => reject(new AiError('badOutput', 'Output too large', stderrText())));
        return;
      }
      bucket.push(d);
    };
    child.stdout!.on('data', collect(out));
    child.stderr!.on('data', collect(err));
    child.stdin!.on('error', () => {
      /* process exited before reading stdin; the exit handler reports it */
    });
    child.on('error', (e: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          e.code === 'ENOENT'
            ? new AiError('notFound', `Executable not found: ${exe}`)
            : new AiError('exit', e.message),
        ),
      );
    });
    child.on('close', (code) => {
      finish(() => {
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = stderrText();
        if (code === 0) resolve({ stdout, stderr });
        else reject(new AiError('exit', `Exited with code ${code}`, stderr || stdout));
      });
    });
    child.stdin!.end(stdin);
  });
}

/** Find an executable on PATH (honours PATHEXT on Windows). */
export function findOnPath(name: string): string | undefined {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean);
  const exts = isWin ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = join(d, name + e);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}
