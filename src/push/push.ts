import { runGit } from '../git/gitRunner';

export type PushInfo = {
  branch: string;
  upstream?: string;
  ahead: number;
  defaultBranch: string;
  remotes: string[];
  /** True when HEAD has no commit yet (as opposed to a detached HEAD). */
  unborn?: boolean;
};

export type PushDecision =
  | { kind: 'nothing' }
  | { kind: 'noRemote' }
  | { kind: 'setUpstream'; remote: string }
  | { kind: 'push'; confirmDefault: boolean };

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

async function readDefaultBranch(root: string, remote: string | undefined): Promise<string> {
  if (remote) {
    const sym = await runGit(root, ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], { allowFail: true, readOnly: true });
    const name = sym.stdout.trim();
    if (sym.code === 0 && name) return name.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : name;
  }
  const refs = ['refs/heads/main', ...(remote ? [`refs/remotes/${remote}/main`] : [])];
  for (const ref of refs) {
    const r = await runGit(root, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true, readOnly: true });
    if (r.code === 0) return 'main';
  }
  return 'master';
}

export async function readPushInfo(root: string): Promise<PushInfo> {
  const remotes = lines((await runGit(root, ['remote'], { readOnly: true })).stdout);
  const defaultBranch = await readDefaultBranch(root, remotes.includes('origin') ? 'origin' : remotes[0]);
  const br = await runGit(root, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true, readOnly: true });
  const head = await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true, readOnly: true });
  // Unborn HEAD counts as "not on a branch": there is nothing to push.
  if (head.code !== 0) return { branch: '', ahead: 0, defaultBranch, remotes, unborn: true };
  const branch = br.code === 0 ? br.stdout.trim() : '';

  const up = await runGit(root, ['rev-parse', '--abbrev-ref', '@{u}'], { allowFail: true, readOnly: true });
  const upstream = up.code === 0 && up.stdout.trim() ? up.stdout.trim() : undefined;
  const countArgs = upstream
    ? ['rev-list', '--count', '@{u}..HEAD']
    : ['rev-list', '--count', 'HEAD', '--not', '--remotes'];
  const ahead = parseInt((await runGit(root, countArgs, { readOnly: true })).stdout.trim(), 10) || 0;
  return { branch, upstream, ahead, defaultBranch, remotes, unborn: false };
}

export function decidePush(info: PushInfo): PushDecision {
  if (info.remotes.length === 0) return { kind: 'noRemote' };
  if (!info.branch) return { kind: 'nothing' };
  if (!info.upstream) {
    return { kind: 'setUpstream', remote: info.remotes.includes('origin') ? 'origin' : info.remotes[0] };
  }
  if (info.ahead === 0) return { kind: 'nothing' };
  // The push lands on the upstream's branch, which can differ from the local branch name.
  const remote = info.remotes.find((r) => info.upstream!.startsWith(r + '/'));
  const target = remote ? info.upstream.slice(remote.length + 1) : info.branch;
  return { kind: 'push', confirmDefault: target === info.defaultBranch };
}

export async function runPush(
  root: string,
  d: { kind: 'push' } | { kind: 'setUpstream'; remote: string },
  branch: string,
): Promise<void> {
  const args = d.kind === 'push' ? ['push'] : ['push', '-u', d.remote, branch];
  await runGit(root, args, { env: { GIT_TERMINAL_PROMPT: '0' } });
}
