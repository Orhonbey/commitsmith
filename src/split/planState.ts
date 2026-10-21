import { resolveScope } from '../git/scope';
import type { FileStatus } from '../git/status';
import type { PlanLocks } from '../prompt/prompts';
import { PlanEdit, PlanGroup, SplitPlan, UNASSIGNED_ID, applyEdit } from './plan';

/** What the extension knows about the open plan tab. */
export type PlanState = {
  plan: SplitPlan;
  /** The working tree changed since the plan was made: Commit stays disabled until Regroup. */
  stale: boolean;
  /** Commit already ran for this plan: only Regroup or Cancel make sense. */
  used: boolean;
};

export type PlanAction =
  | { kind: 'render' }
  | { kind: 'cancel' }
  | { kind: 'commit'; plan: SplitPlan; pushAfter: boolean }
  | { kind: 'regroup'; locks: PlanLocks }
  /** A legitimate request that cannot run; the panel explains it to the user. */
  | { kind: 'invalid'; code: 'stale' | 'noneChecked' | 'emptyMessage' }
  /** Malformed or forged message: dropped silently. */
  | { kind: 'ignore' };

const MAX_TEXT = 20000;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isText = (x: unknown): x is string => typeof x === 'string' && x.length <= MAX_TEXT;
const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === 'string');

export function planFiles(plan: SplitPlan): Set<string> {
  return new Set([...plan.groups.flatMap((g) => g.files), ...plan.unassigned]);
}

function parseEdit(raw: unknown, plan: SplitPlan): PlanEdit | undefined {
  if (!isObj(raw)) return undefined;
  const ids = new Set(plan.groups.map((g) => g.id));
  const files = planFiles(plan);
  const group = typeof raw.groupId === 'string' && ids.has(raw.groupId) ? raw.groupId : undefined;
  switch (raw.kind) {
    case 'move':
      return typeof raw.file === 'string' && files.has(raw.file) && typeof raw.toGroupId === 'string' && (ids.has(raw.toGroupId) || raw.toGroupId === UNASSIGNED_ID)
        ? { kind: 'move', file: raw.file, toGroupId: raw.toGroupId }
        : undefined;
    case 'message':
      return group && isText(raw.text) ? { kind: 'message', groupId: group, text: raw.text } : undefined;
    case 'toggle':
      return group ? { kind: 'toggle', groupId: group } : undefined;
    case 'reorder':
      return group && (raw.delta === 1 || raw.delta === -1) ? { kind: 'reorder', groupId: group, delta: raw.delta } : undefined;
    default:
      return undefined;
  }
}

/** Rebuilds a plan from webview data: only the user-editable fields are taken from it. */
function parseCommitPlan(raw: unknown, held: SplitPlan): SplitPlan | undefined {
  if (!isObj(raw) || !Array.isArray(raw.groups) || !isStrings(raw.unassigned)) return undefined;
  const universe = planFiles(held);
  const heldById = new Map(held.groups.map((g) => [g.id, g]));
  const seenFiles = new Set<string>();
  const seenIds = new Set<string>();
  const take = (files: string[]): string[] | undefined => {
    for (const f of files) {
      if (!universe.has(f) || seenFiles.has(f)) return undefined;
      seenFiles.add(f);
    }
    return files;
  };
  const groups: PlanGroup[] = [];
  for (const g of raw.groups) {
    if (!isObj(g) || typeof g.id !== 'string' || seenIds.has(g.id)) return undefined;
    const h = heldById.get(g.id);
    if (!h || !isText(g.message) || typeof g.checked !== 'boolean' || !isStrings(g.files)) return undefined;
    const files = take(g.files);
    if (!files) return undefined;
    seenIds.add(g.id);
    groups.push({ ...h, message: g.message, checked: g.checked, files, locked: h.locked || g.message !== h.message });
  }
  const unassigned = take(raw.unassigned);
  if (!unassigned) return undefined;
  return { groups, unassigned: [...unassigned, ...[...universe].filter((f) => !seenFiles.has(f))] };
}

function parseLocks(raw: unknown, held: SplitPlan): PlanLocks | undefined {
  if (!isObj(raw) || !Array.isArray(raw.groups)) return undefined;
  const universe = planFiles(held);
  const seen = new Set<string>();
  const groups: PlanLocks['groups'] = [];
  for (const g of raw.groups) {
    if (!isObj(g) || !isText(g.message) || !isStrings(g.files) || g.files.length === 0) return undefined;
    for (const f of g.files) {
      if (!universe.has(f) || seen.has(f)) return undefined;
      seen.add(f);
    }
    groups.push({ message: g.message, files: g.files });
  }
  return { groups };
}

/**
 * Pure protocol handler for messages posted by the plan webview. Everything in `raw` is
 * untrusted: it is validated against the plan the extension holds before anything acts on it.
 */
export function handlePlanMessage(state: PlanState, raw: unknown): { state: PlanState; action: PlanAction } {
  const ignore = { state, action: { kind: 'ignore' } as PlanAction };
  if (!isObj(raw) || typeof raw.type !== 'string') return ignore;
  switch (raw.type) {
    case 'ready':
      return { state, action: { kind: 'render' } };
    case 'cancel':
      return { state, action: { kind: 'cancel' } };
    case 'edit': {
      const edit = parseEdit(raw.edit, state.plan);
      return edit ? { state: { ...state, plan: applyEdit(state.plan, edit) }, action: { kind: 'render' } } : ignore;
    }
    case 'regroup': {
      const locks = parseLocks(raw.locks, state.plan);
      return locks ? { state, action: { kind: 'regroup', locks } } : ignore;
    }
    case 'commit': {
      const pushAfter = raw.pushAfter;
      const plan = typeof pushAfter === 'boolean' ? parseCommitPlan(raw.plan, state.plan) : undefined;
      if (!plan || typeof pushAfter !== 'boolean') return ignore;
      const next = { ...state, plan };
      if (state.stale || state.used) return { state: next, action: { kind: 'invalid', code: 'stale' } };
      const checked = plan.groups.filter((g) => g.checked && g.files.length > 0);
      if (checked.length === 0) return { state: next, action: { kind: 'invalid', code: 'noneChecked' } };
      if (checked.some((g) => g.message.trim() === '')) return { state: next, action: { kind: 'invalid', code: 'emptyMessage' } };
      return { state: next, action: { kind: 'commit', plan, pushAfter } };
    }
    default:
      return ignore;
  }
}

/** Identity of the scoped changes (paths + status letters): differs when the working tree moved on. */
export function fingerprintOf(status: FileStatus[]): string {
  const byPath = new Map(status.map((s) => [s.path, s]));
  return resolveScope(status, { includeUntracked: true })
    .files.map((f) => {
      const s = byPath.get(f.path);
      return `${f.path}|${s?.index ?? ''}${s?.worktree ?? ''}${s?.untracked ? '?' : ''}`;
    })
    .sort()
    .join(String.fromCharCode(10));
}
