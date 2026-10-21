import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runGit } from '../../src/git/gitRunner';

export interface TempRepo {
  root: string;
  git(...args: string[]): Promise<string>;
  write(p: string, c: string | Buffer): void;
  cleanup(): Promise<void>;
}

export async function createTempRepo(files: Record<string, string | Buffer> = {}): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), 'commitsmith-'));
  const git = async (...args: string[]) => (await runGit(root, args)).stdout;
  const write = (p: string, c: string | Buffer) => {
    const full = join(root, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, c);
  };
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Test User');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'core.autocrlf', 'false');
  await git('config', 'commit.gpgsign', 'false');
  for (const [p, c] of Object.entries(files)) write(p, c);
  if (Object.keys(files).length > 0) {
    await git('add', '-A');
    await git('commit', '-m', 'init');
  }
  return { root, git, write, cleanup: () => rm(root, { recursive: true, force: true }) };
}
