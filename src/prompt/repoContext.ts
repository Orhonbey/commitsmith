import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runGit } from '../git/gitRunner';

export type RepoContext = {
  branch: string;
  recentSubjects: string[];
  rules: { file: string; text: string }[];
};

const RULE_FILES = ['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', '.gitmessage', '.github/CONTRIBUTING.md'];
const PER_FILE_CAP = 8_000;
const TOTAL_CAP = 16_000;

export async function readRepoContext(root: string): Promise<RepoContext> {
  let branch = '';
  const head = await runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true, readOnly: true });
  if (head.code === 0) branch = head.stdout.trim();
  else {
    const sym = await runGit(root, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true, readOnly: true });
    if (sym.code === 0) branch = sym.stdout.trim();
  }

  const log = await runGit(root, ['log', '-20', '--format=%s'], { allowFail: true, readOnly: true });
  const recentSubjects = log.code === 0 ? log.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : [];

  const rules: RepoContext['rules'] = [];
  let total = 0;
  for (const file of RULE_FILES) {
    if (total >= TOTAL_CAP) break;
    let text: string;
    try {
      text = await readFile(join(root, file), 'utf8');
    } catch {
      continue;
    }
    text = text.slice(0, Math.min(PER_FILE_CAP, TOTAL_CAP - total));
    if (!text) continue;
    rules.push({ file, text });
    total += text.length;
  }
  return { branch, recentSubjects, rules };
}
