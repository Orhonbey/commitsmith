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
const state = (o: Partial<PlanState> = {}): PlanState => ({ plan: plan(), stale: false, used: false, revision: 3, ...o });
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe('plan message protocol', () => {
  const rev = { revision: 3 };

  it('edit applies applyEdit and asks for a render', () => {
    const r = handlePlanMessage(state(), { type: 'edit', ...rev, edit: { kind: 'move', file: 'a.txt', toGroupId: 'g2' } });
    assert.equal(r.action.kind, 'render');
    assert.deepEqual(r.state.plan.groups[1].files, ['b.txt', 'a.txt', 'a.txt.meta']);
    assert.equal(r.state.plan.groups[1].locked, true);
  });

  it('malformed or forged messages are ignored and change nothing', () => {
    const s = state();
    const bad: unknown[] = [
      null, 'x', 5, {}, { type: 'nope' }, { type: 'edit', ...rev }, { type: 'edit', ...rev, edit: { kind: 'move', file: 'a.txt' } },
      { type: 'edit', ...rev, edit: { kind: 'move', file: 'evil.txt', toGroupId: 'g1' } },
      { type: 'edit', ...rev, edit: { kind: 'move', file: 'a.txt', toGroupId: 'g9' } },
      { type: 'edit', ...rev, edit: { kind: 'message', groupId: 'g1', text: 5 } },
      { type: 'edit', ...rev, edit: { kind: 'reorder', groupId: 'g1', delta: 2 } },
      { type: 'edit', ...rev, edit: { kind: 'toggle', groupId: 'zz' } },
      { type: 'commit', ...rev, pushAfter: 'yes' },
      { type: 'commit', ...rev },
    ];
    for (const m of bad) {
      const r = handlePlanMessage(s, m);
      assert.equal(r.action.kind, 'ignore', JSON.stringify(m));
      assert.deepEqual(r.state, state());
    }
  });

  it('a stale-revision edit is ignored', () => {
    for (const revision of [2, 4, undefined, '3']) {
      const r = handlePlanMessage(state(), { type: 'edit', revision, edit: { kind: 'toggle', groupId: 'g1' } });
      assert.equal(r.action.kind, 'ignore');
      assert.deepEqual(r.state, state());
    }
  });

  it('a stale-revision commit or regroup is ignored', () => {
    assert.equal(handlePlanMessage(state(), { type: 'commit', revision: 2, pushAfter: false }).action.kind, 'ignore');
    assert.equal(handlePlanMessage(state(), { type: 'commit', pushAfter: false }).action.kind, 'ignore');
    assert.equal(handlePlanMessage(state(), { type: 'regroup', revision: 1 }).action.kind, 'ignore');
  });

  it('commit uses the held plan, not anything the webview sends', () => {
    const forged: any = clone(plan());
    forged.groups[0].files.push('evil.txt');
    forged.groups[0].message = 'forged';
    const edited = handlePlanMessage(state(), { type: 'edit', ...rev, edit: { kind: 'move', file: 'b.txt', toGroupId: 'g1' } }).state;
    const r = handlePlanMessage(edited, { type: 'commit', ...rev, pushAfter: true, plan: forged });
    assert.equal(r.action.kind, 'commit');
    if (r.action.kind !== 'commit') return;
    assert.equal(r.action.pushAfter, true);
    assert.deepEqual(r.action.plan, edited.plan);
    assert.deepEqual(r.action.plan.groups[0].files, ['a.txt', 'a.txt.meta', 'b.txt']);
  });

  it('a move whose edit arrived before the commit is kept (no silent undo)', () => {
    const start = state();
    start.plan.groups[1].checked = true;
    const moved = handlePlanMessage(start, { type: 'edit', ...rev, edit: { kind: 'move', file: 'a.txt', toGroupId: 'g2' } }).state;
    const r = handlePlanMessage(moved, { type: 'commit', ...rev, pushAfter: false });
    if (r.action.kind !== 'commit') return assert.fail('expected commit');
    assert.ok(r.action.plan.groups[1].files.includes('a.txt'));
    assert.ok(!r.action.plan.groups[0].files.includes('a.txt'));
  });

  it('commit is refused while stale, after use, with nothing checked or with an empty message', () => {
    const msg = { type: 'commit', ...rev, pushAfter: false };
    assert.deepEqual(handlePlanMessage(state({ stale: true }), msg).action, { kind: 'invalid', code: 'stale' });
    assert.deepEqual(handlePlanMessage(state({ used: true }), msg).action, { kind: 'invalid', code: 'stale' });
    const none = state();
    none.plan.groups[0].checked = false;
    assert.deepEqual(handlePlanMessage(none, msg).action, { kind: 'invalid', code: 'noneChecked' });
    const empty = state();
    empty.plan.groups[0].message = '   ';
    assert.deepEqual(handlePlanMessage(empty, msg).action, { kind: 'invalid', code: 'emptyMessage' });
  });

  it('an unchecked group with an empty message does not block the commit', () => {
    const s = state();
    s.plan.groups[1].message = '';
    assert.equal(handlePlanMessage(s, { type: 'commit', ...rev, pushAfter: false }).action.kind, 'commit');
  });

  it('regroup computes the locks from the held plan, even when stale; cancel and ready pass through', () => {
    const edited = handlePlanMessage(state({ stale: true }), { type: 'edit', ...rev, edit: { kind: 'message', groupId: 'g2', text: 'mine' } }).state;
    assert.deepEqual(handlePlanMessage(edited, { type: 'regroup', ...rev, locks: { groups: [{ message: 'x', files: ['evil'] }] } }).action, {
      kind: 'regroup',
      locks: { groups: [{ message: 'mine', files: ['b.txt'], checked: false }] },
    });
    assert.deepEqual(handlePlanMessage(state(), { type: 'cancel' }).action, { kind: 'cancel' });
    assert.equal(handlePlanMessage(state(), { type: 'ready' }).action.kind, 'render');
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
