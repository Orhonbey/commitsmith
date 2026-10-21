import { runGit } from '../git/gitRunner';

export type PushInfo = {
  branch: string;
  upstream?: string;
  ahead: number;
  defaultBranch: string;
  remotes: string[];
};

export type PushDecision =
  | { kind: 'nothing' }
  | { kind: 'noRemote' }
  | { kind: 'setUpstream'; remote: string }
  | { kind: 'push'; confirmDefault: boolean };

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

async function readDefaultBranch(root: string): Promise<string> {
  const sym = await runGit(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true });
  const name = sym.stdout.trim();
  if (sym.code === 0 && name) return name.replace(/^origin\//, '');
  const main = await runGit(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { allowFail: true });
  if (main.code === 0) return 'main';
  const remoteMain = await runGit(root, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { allowFail: true });
  return remoteMain.code === 0 ? 'main' : 'master';
}

export async function readPushInfo(root: string): Promise<PushInfo> {
  const remotes = lines((await runGit(root, ['remote'])).stdout);
  const defaultBranch = await readDefaultBranch(root);
  const br = await runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true });
  const branch = br.code === 0 ? br.stdout.trim() : '';
  const head = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true });
  if (head.code !== 0) return { branch, ahead: 0, defaultBranch, remotes };

  const up = await runGit(root, ['rev-parse', '--abbrev-ref', '@{u}'], { allowFail: true });
  const upstream = up.code === 0 && up.stdout.trim() ? up.stdout.trim() : undefined;
  const countArgs = upstream
    ? ['rev-list', '--count', '@{u}..HEAD']
    : ['rev-list', '--count', 'HEAD', '--not', '--remotes'];
  const ahead = parseInt((await runGit(root, countArgs)).stdout.trim(), 10) || 0;
  return { branch, upstream, ahead, defaultBranch, remotes };
}

export function decidePush(info: PushInfo): PushDecision {
  if (info.remotes.length === 0) return { kind: 'noRemote' };
  if (!info.branch) return { kind: 'nothing' };
  if (!info.upstream) {
    if (info.ahead === 0) return { kind: 'nothing' };
    return { kind: 'setUpstream', remote: info.remotes.includes('origin') ? 'origin' : info.remotes[0] };
  }
  if (info.ahead === 0) return { kind: 'nothing' };
  return { kind: 'push', confirmDefault: info.branch === info.defaultBranch };
}

export async function runPush(
  root: string,
  d: { kind: 'push' } | { kind: 'setUpstream'; remote: string },
  branch: string,
): Promise<void> {
  const args = d.kind === 'push' ? ['push'] : ['push', '-u', d.remote, branch];
  await runGit(root, args, { env: { GIT_TERMINAL_PROMPT: '0' } });
}
