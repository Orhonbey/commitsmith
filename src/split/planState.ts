import { resolveScope } from '../git/scope';
import type { FileStatus } from '../git/status';
import type { PlanLocks } from '../prompt/prompts';
import { PlanEdit, SplitPlan, UNASSIGNED_ID, applyEdit, locksOf } from './plan';

/** What the extension knows about the open plan tab. */
export type PlanState = {
  plan: SplitPlan;
  /** The working tree changed since the plan was made: Commit stays disabled until Regroup. */
  stale: boolean;
  /** Commit already ran for this plan: only Regroup or Cancel make sense. */
  used: boolean;
  /** Bumped whenever a new plan replaces the old one (Regroup). */
  revision: number;
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

/**
 * Pure protocol handler for messages posted by the plan webview. Everything in `raw` is
 * untrusted. Edits, commit and regroup must carry the current plan revision, so a message
 * composed against an older plan is dropped. Commit and regroup act on the plan the extension
 * holds, never on file lists from the webview.
 */
export function handlePlanMessage(state: PlanState, raw: unknown): { state: PlanState; action: PlanAction } {
  const ignore = { state, action: { kind: 'ignore' } as PlanAction };
  if (!isObj(raw) || typeof raw.type !== 'string') return ignore;
  switch (raw.type) {
    case 'ready':
      return { state, action: { kind: 'render' } };
    case 'cancel':
      return { state, action: { kind: 'cancel' } };
  }
  if (raw.revision !== state.revision) return ignore;
  switch (raw.type) {
    case 'edit': {
      const edit = parseEdit(raw.edit, state.plan);
      return edit ? { state: { ...state, plan: applyEdit(state.plan, edit) }, action: { kind: 'render' } } : ignore;
    }
    case 'regroup':
      return { state, action: { kind: 'regroup', locks: locksOf(state.plan) } };
    case 'commit': {
      if (typeof raw.pushAfter !== 'boolean') return ignore;
      const plan = state.plan;
      if (state.stale || state.used) return { state, action: { kind: 'invalid', code: 'stale' } };
      const checked = plan.groups.filter((g) => g.checked && g.files.length > 0);
      if (checked.length === 0) return { state, action: { kind: 'invalid', code: 'noneChecked' } };
      if (checked.some((g) => g.message.trim() === '')) return { state, action: { kind: 'invalid', code: 'emptyMessage' } };
      return { state, action: { kind: 'commit', plan, pushAfter: raw.pushAfter } };
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
