import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import type { FileStatus } from '../../src/git/status';
import { PlanState, fingerprintOf, handlePlanMessage } from '../../src/split/planState';
import type { SplitPlan } from '../../src/split/plan';

const grp = (id: string, files: string[], o: Record<string, unknown> = {}) => ({
  id, message: 'm-' + id, files, reason: 'why ' + id, uncertain: false, checked: true, locked: false, ...o,
});
const plan = (): SplitPlan => ({
  groups: [grp('g1', ['a.txt', 'a.txt.meta']), grp('g2', ['b.txt'], { uncertain: true, checked: false })],
  unassigned: ['u.txt'],
});
const state = (o: Partial<PlanState> = {}): PlanState => ({ plan: plan(), stale: false, used: false, ...o });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('plan message protocol', () => {
  it('edit applies applyEdit and asks for a render', () => {
    const r = handlePlanMessage(state(), { type: 'edit', edit: { kind: 'move', file: 'a.txt', toGroupId: 'g2' } });
    assert.equal(r.action.kind, 'render');
    assert.deepEqual(r.state.plan.groups[1].files, ['b.txt', 'a.txt', 'a.txt.meta']);
    assert.equal(r.state.plan.groups[1].locked, true);
  });

  it('malformed or forged messages are ignored and change nothing', () => {
    const s = state();
    const bad: unknown[] = [
      null, 'x', 5, {}, { type: 'nope' }, { type: 'edit' }, { type: 'edit', edit: { kind: 'move', file: 'a.txt' } },
      { type: 'edit', edit: { kind: 'move', file: 'evil.txt', toGroupId: 'g1' } },
      { type: 'edit', edit: { kind: 'move', file: 'a.txt', toGroupId: 'g9' } },
      { type: 'edit', edit: { kind: 'message', groupId: 'g1', text: 5 } },
      { type: 'edit', edit: { kind: 'reorder', groupId: 'g1', delta: 2 } },
      { type: 'edit', edit: { kind: 'toggle', groupId: 'zz' } },
      { type: 'regroup', locks: { groups: [{ message: 'x', files: ['../etc/passwd'] }] } },
      { type: 'regroup', locks: 'x' },
      { type: 'commit', plan: 'x', pushAfter: false },
      { type: 'commit', plan: { groups: [], unassigned: [] }, pushAfter: 'yes' },
    ];
    for (const m of bad) {
      const r = handlePlanMessage(s, m);
      assert.equal(r.action.kind, 'ignore', JSON.stringify(m));
      assert.deepEqual(r.state, state());
    }
  });

  it('commit with a file not in the plan, an unknown group id or a duplicated file is ignored', () => {
    const mk = (f: (p: any) => void) => {
      const p = clone(plan());
      f(p);
      return { type: 'commit', plan: p, pushAfter: false };
    };
    for (const m of [
      mk((p) => p.groups[0].files.push('evil.txt')),
      mk((p) => (p.groups[0].id = 'g7')),
      mk((p) => p.groups[1].files.push('a.txt')),
      mk((p) => p.groups.push(clone(p.groups[0]))),
    ]) {
      assert.equal(handlePlanMessage(state(), m).action.kind, 'ignore');
    }
  });

  it('commit returns a sanitised plan: reason and uncertain come from the held plan', () => {
    const p: any = clone(plan());
    p.groups[0].reason = '<img src=x onerror=alert(1)>';
    p.groups[0].uncertain = true;
    p.groups[0].message = 'edited';
    p.groups.reverse();
    const r = handlePlanMessage(state(), { type: 'commit', plan: p, pushAfter: true });
    assert.equal(r.action.kind, 'commit');
    if (r.action.kind !== 'commit') return;
    assert.equal(r.action.pushAfter, true);
    assert.deepEqual(r.action.plan.groups.map((g) => g.id), ['g2', 'g1']);
    const g1 = r.action.plan.groups[1];
    assert.equal(g1.reason, 'why g1');
    assert.equal(g1.uncertain, false);
    assert.equal(g1.message, 'edited');
    assert.equal(g1.locked, true);
    assert.deepEqual(r.action.plan.unassigned, ['u.txt']);
  });

  it('commit: files left out by the webview become unassigned, not lost', () => {
    const p: any = clone(plan());
    p.groups[0].files = ['a.txt'];
    p.unassigned = [];
    const r = handlePlanMessage(state(), { type: 'commit', plan: p, pushAfter: false });
    assert.equal(r.action.kind, 'commit');
    if (r.action.kind === 'commit') assert.deepEqual([...r.action.plan.unassigned].sort(), ['a.txt.meta', 'u.txt']);
  });

  it('commit is refused while stale, after use, with nothing checked or with an empty message', () => {
    const msg = { type: 'commit', plan: plan(), pushAfter: false };
    assert.deepEqual(handlePlanMessage(state({ stale: true }), msg).action, { kind: 'invalid', code: 'stale' });
    assert.deepEqual(handlePlanMessage(state({ used: true }), msg).action, { kind: 'invalid', code: 'stale' });
    const none: any = clone(plan());
    none.groups[0].checked = false;
    assert.deepEqual(handlePlanMessage(state(), { ...msg, plan: none }).action, { kind: 'invalid', code: 'noneChecked' });
    const empty: any = clone(plan());
    empty.groups[0].message = '   ';
    assert.deepEqual(handlePlanMessage(state(), { ...msg, plan: empty }).action, { kind: 'invalid', code: 'emptyMessage' });
  });

  it('an unchecked group with an empty message does not block the commit', () => {
    const p: any = clone(plan());
    p.groups[1].message = '';
    assert.equal(handlePlanMessage(state(), { type: 'commit', plan: p, pushAfter: false }).action.kind, 'commit');
  });

  it('regroup passes validated locks, even when stale; cancel and ready pass through', () => {
    const locks = { groups: [{ message: 'mine', files: ['a.txt', 'a.txt.meta'] }] };
    assert.deepEqual(handlePlanMessage(state({ stale: true }), { type: 'regroup', locks }).action, { kind: 'regroup', locks });
    assert.deepEqual(handlePlanMessage(state(), { type: 'cancel' }).action, { kind: 'cancel' });
    assert.equal(handlePlanMessage(state(), { type: 'ready' }).action.kind, 'render');
  });

  it('regroup rejects a file listed in two locked groups', () => {
    const locks = { groups: [{ message: 'a', files: ['a.txt'] }, { message: 'b', files: ['a.txt'] }] };
    assert.equal(handlePlanMessage(state(), { type: 'regroup', locks }).action.kind, 'ignore');
  });

  describe('fingerprintOf', () => {
    const st = (path: string, index: FileStatus['index'], worktree: FileStatus['worktree'], untracked = false): FileStatus => ({ path, index, worktree, untracked });
    it('is stable for the same status and changes with paths or status letters', () => {
      const a = [st('a.txt', '.', 'M'), st('b.txt', '.', '.', true)];
      assert.equal(fingerprintOf(a), fingerprintOf([...a].reverse()));
      assert.notEqual(fingerprintOf(a), fingerprintOf([st('a.txt', '.', 'D'), st('b.txt', '.', '.', true)]));
      assert.notEqual(fingerprintOf(a), fingerprintOf([...a, st('c.txt', '.', 'M')]));
    });
    it('treats untracked files as part of the scope and ignores them once something is staged', () => {
      assert.notEqual(fingerprintOf([st('a.txt', '.', 'M')]), fingerprintOf([st('a.txt', '.', 'M'), st('n.txt', '.', '.', true)]));
      assert.equal(fingerprintOf([st('a.txt', 'M', '.')]), fingerprintOf([st('a.txt', 'M', '.'), st('n.txt', '.', '.', true)]));
    });
  });
});
