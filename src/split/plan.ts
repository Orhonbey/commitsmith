import type { CommitGroup } from '../git/commitEngine';
import type { ScopedFile } from '../git/scope';
import type { PlanLocks } from '../prompt/prompts';

export type PlanGroup = {
  id: string;
  message: string;
  files: string[];
  reason: string;
  uncertain: boolean;
  checked: boolean;
  locked: boolean;
};

export type SplitPlan = { groups: PlanGroup[]; unassigned: string[] };

export class PlanError extends Error {
  constructor(
    message: string,
    public unknownPaths: string[] = [],
    public duplicatePaths: string[] = [],
  ) {
    super(message);
    this.name = 'PlanError';
  }
}

// ---- parsing ---------------------------------------------------------------

type RawGroup = { message?: unknown; files?: unknown; reason?: unknown; uncertain?: unknown };

function canonicalizer(scoped: ScopedFile[]): (p: string) => string | undefined {
  const known = new Set(scoped.map((f) => f.path));
  const byOrig = new Map<string, string>();
  for (const f of scoped) if (f.origPath && !known.has(f.origPath)) byOrig.set(f.origPath, f.path);
  return (p) => (known.has(p) ? p : byOrig.get(p));
}

export function parsePlan(json: string, scoped: ScopedFile[], locks?: PlanLocks): SplitPlan {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new PlanError(`The AI did not return valid JSON: ${(e as Error).message}`);
  }
  const rawGroups = (raw as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(rawGroups)) throw new PlanError('The AI plan has no "groups" list.');

  const canon = canonicalizer(scoped);
  const unknown: string[] = [];
  const dupes: string[] = [];
  const seen = new Set<string>();
  const ai: { message: string; files: string[]; reason: string; uncertain: boolean }[] = [];

  for (const g of rawGroups as RawGroup[]) {
    const files: string[] = [];
    const inGroup = new Set<string>();
    for (const f of Array.isArray(g?.files) ? (g.files as unknown[]) : []) {
      const p = typeof f === 'string' ? canon(f) : undefined;
      if (p === undefined) {
        if (!unknown.includes(String(f))) unknown.push(String(f));
      } else if (inGroup.has(p)) {
        // same file named twice in one group (e.g. a rename by new and old path): harmless
      } else if (seen.has(p)) {
        if (!dupes.includes(p)) dupes.push(p);
      } else {
        seen.add(p);
        inGroup.add(p);
        files.push(p);
      }
    }
    ai.push({
      message: typeof g?.message === 'string' ? g.message : '',
      files,
      reason: typeof g?.reason === 'string' ? g.reason : '',
      uncertain: g?.uncertain === true,
    });
  }
  if (unknown.length > 0 || dupes.length > 0) {
    const parts = [];
    if (unknown.length > 0) parts.push(`paths not in scope: ${unknown.join(', ')}`);
    if (dupes.length > 0) parts.push(`paths listed twice: ${dupes.join(', ')}`);
    throw new PlanError(`The AI plan is invalid (${parts.join('; ')}).`, unknown, dupes);
  }

  const lockedSet = new Set<string>();
  const lockedGroups = (locks?.groups ?? [])
    .map((g) => ({
      message: g.message,
      files: [...new Set(g.files.map(canon).filter((p): p is string => p !== undefined))].filter((p) => {
        if (lockedSet.has(p)) return false; // first locked group wins
        lockedSet.add(p);
        return true;
      }),
    }))
    .filter((g) => g.files.length > 0);

  const groups: PlanGroup[] = [];
  const push = (g: Omit<PlanGroup, 'id' | 'checked'>) =>
    groups.push({ ...g, id: `g${groups.length + 1}`, checked: !g.uncertain });
  for (const g of lockedGroups) push({ message: g.message, files: g.files, reason: '', uncertain: false, locked: true });
  for (const g of ai) {
    const files = g.files.filter((p) => !lockedSet.has(p));
    if (files.length > 0) push({ ...g, files, locked: false });
  }

  const assigned = new Set(groups.flatMap((g) => g.files));
  return { groups, unassigned: scoped.map((f) => f.path).filter((p) => !assigned.has(p)) };
}

// ---- companions ------------------------------------------------------------

/** Keeps each .meta in the same group as its asset (a locked side wins; an unassigned asset follows its .meta). */
export function pairCompanions(plan: SplitPlan, scoped: ScopedFile[]): SplitPlan {
  const sets = plan.groups.map((g) => new Set(g.files));
  const unassigned = new Set(plan.unassigned);
  const loc = new Map<string, number>(); // path -> group index, -1 = unassigned
  plan.unassigned.forEach((p) => loc.set(p, -1));
  sets.forEach((set, i) => set.forEach((p) => loc.set(p, i)));
  const inScope = new Set(scoped.map((f) => f.path));
  const move = (p: string, to: number) => {
    const from = loc.get(p) ?? -1;
    if (from === to) return;
    if (from === -1) unassigned.delete(p);
    else sets[from].delete(p);
    if (to === -1) unassigned.add(p);
    else sets[to].add(p);
    loc.set(p, to);
  };

  for (const f of scoped) {
    if (!f.path.endsWith('.meta')) continue;
    const base = f.path.slice(0, -'.meta'.length);
    if (!inScope.has(base)) continue;
    const mi = loc.get(f.path) ?? -1;
    const bi = loc.get(base) ?? -1;
    if (mi === bi) continue;
    const metaLocked = mi >= 0 && plan.groups[mi].locked;
    const baseLocked = bi >= 0 && plan.groups[bi].locked;
    if (metaLocked && baseLocked) continue;
    // A locked side keeps its file; otherwise the .meta follows its asset, unless the asset is unassigned.
    if (metaLocked || (bi === -1 && mi >= 0 && !baseLocked)) move(base, mi);
    else move(f.path, bi);
  }
  const groups = plan.groups.map((g, i) => ({ ...g, files: [...sets[i]] })).filter((g) => g.files.length > 0);
  return { groups, unassigned: [...unassigned] };
}

// ---- output ----------------------------------------------------------------

export function toCommitGroups(plan: SplitPlan, scoped: ScopedFile[]): CommitGroup[] {
  const orig = new Map(scoped.filter((f) => f.origPath).map((f) => [f.path, f.origPath as string]));
  return plan.groups
    .filter((g) => g.checked && g.files.length > 0)
    .map((g) => {
      const paths = [...g.files];
      for (const p of g.files) {
        const o = orig.get(p);
        if (o && !paths.includes(o)) paths.push(o);
      }
      return { message: g.message, paths };
    });
}

// ---- editing ---------------------------------------------------------------

export type PlanEdit =
  | { kind: 'move'; file: string; toGroupId: string }
  | { kind: 'message'; groupId: string; text: string }
  | { kind: 'toggle'; groupId: string }
  | { kind: 'reorder'; groupId: string; delta: -1 | 1 };

export const UNASSIGNED_ID = 'unassigned';

function companionOf(file: string): string {
  return file.endsWith('.meta') ? file.slice(0, -'.meta'.length) : `${file}.meta`;
}

/** Pure: returns a new plan. Moving a file or editing a message locks the touched groups. */
export function applyEdit(plan: SplitPlan, edit: PlanEdit): SplitPlan {
  const groups = plan.groups.map((g) => ({ ...g, files: [...g.files] }));
  let unassigned = [...plan.unassigned];
  const index = groups.findIndex((g) => 'groupId' in edit && g.id === edit.groupId);

  switch (edit.kind) {
    case 'message':
      if (index < 0) return plan;
      groups[index].message = edit.text;
      groups[index].locked = true;
      break;
    case 'toggle':
      if (index < 0) return plan;
      groups[index].checked = !groups[index].checked;
      break;
    case 'reorder': {
      const to = index + edit.delta;
      if (index < 0 || to < 0 || to >= groups.length) return plan;
      [groups[index], groups[to]] = [groups[to], groups[index]];
      break;
    }
    case 'move': {
      const dest = edit.toGroupId === UNASSIGNED_ID ? -1 : groups.findIndex((g) => g.id === edit.toGroupId);
      if (dest < 0 && edit.toGroupId !== UNASSIGNED_ID) return plan;
      // -1 = unassigned, undefined = not in the plan
      const where = (f: string): number | undefined =>
        unassigned.includes(f) ? -1 : groups.some((g) => g.files.includes(f)) ? groups.findIndex((g) => g.files.includes(f)) : undefined;
      const at = where(edit.file);
      if (at === undefined || at === dest) return plan;
      for (const f of [edit.file, companionOf(edit.file)]) {
        const from = where(f);
        if (from === undefined || from === dest) continue;
        if (from === -1) unassigned = unassigned.filter((p) => p !== f);
        else {
          groups[from].files = groups[from].files.filter((p) => p !== f);
          groups[from].locked = true;
        }
        if (dest === -1) unassigned.push(f);
        else {
          groups[dest].files.push(f);
          groups[dest].locked = true;
        }
      }
      break;
    }
  }
  return { groups, unassigned };
}

/** The groups the user touched; Regroup must keep them as they are. */
export function locksOf(plan: SplitPlan): PlanLocks {
  return {
    groups: plan.groups.filter((g) => g.locked && g.files.length > 0).map((g) => ({ message: g.message, files: [...g.files] })),
  };
}
