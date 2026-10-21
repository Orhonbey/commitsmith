import { runGit } from './gitRunner';

export type StatusCode = '.' | 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U';

export type FileStatus = {
  path: string;
  origPath?: string;
  index: StatusCode;
  worktree: StatusCode;
  untracked: boolean;
};

/** Parse the output of `git status --porcelain=v2 -z --untracked-files=all`. */
export function parseStatus(raw: string): FileStatus[] {
  const parts = raw.split('\0');
  const result: FileStatus[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const kind = rec[0];
    if (kind === '?') {
      result.push({ path: rec.slice(2), index: '.', worktree: '.', untracked: true });
    } else if (kind === '1') {
      // 1 XY sub mH mI mW hH hI path
      const f = rec.split(' ');
      result.push(entry(f[1], f.slice(8).join(' ')));
    } else if (kind === '2') {
      // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
      const f = rec.split(' ');
      const orig = parts[++i];
      result.push({ ...entry(f[1], f.slice(9).join(' ')), origPath: orig });
    } else if (kind === 'u') {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const f = rec.split(' ');
      result.push(entry(f[1], f.slice(10).join(' ')));
    }
    // Ignored entries and headers are skipped.
  }
  return result;
}

function entry(xy: string, path: string): FileStatus {
  return { path, index: xy[0] as StatusCode, worktree: xy[1] as StatusCode, untracked: false };
}

export async function readStatus(root: string): Promise<FileStatus[]> {
  const { stdout } = await runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { readOnly: true });
  return parseStatus(stdout);
}
