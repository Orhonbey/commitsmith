import assert from 'node:assert/strict';
import { describe, it } from 'mocha';
import type { ScopedFile } from '../../src/git/scope';
import { PlanError, pairCompanions, parsePlan, toCommitGroups } from '../../src/split/plan';

const sf = (path: string, o: Partial<ScopedFile> = {}): ScopedFile => ({ path, change: 'modified', isNew: false, ...o });
const ai = (groups: { message: string; files: string[]; uncertain?: boolean }[]) =>
  JSON.stringify({ groups: groups.map((g) => ({ reason: 'r', uncertain: false, ...g })), unassigned: [] });

describe('split plan', () => {
  it('valid plan parses, uncertain unchecked', () => {
    const plan = parsePlan(
      ai([{ message: 'a', files: ['a.txt'] }, { message: 'b', files: ['b.txt'], uncertain: true }]),
      [sf('a.txt'), sf('b.txt')],
    );
    assert.deepEqual(plan.groups.map((g) => [g.id, g.checked, g.locked]), [['g1', true, false], ['g2', false, false]]);
    assert.deepEqual(plan.unassigned, []);
  });

  it('unknown path -> PlanError.unknownPaths', () => {
    assert.throws(
      () => parsePlan(ai([{ message: 'a', files: ['a.txt', 'zzz.txt'] }]), [sf('a.txt')]),
      (e: unknown) => e instanceof PlanError && e.unknownPaths.join() === 'zzz.txt',
    );
  });

  it('duplicate path -> PlanError.duplicatePaths', () => {
    assert.throws(
      () => parsePlan(ai([{ message: 'a', files: ['a.txt'] }, { message: 'b', files: ['a.txt'] }]), [sf('a.txt')]),
      (e: unknown) => e instanceof PlanError && e.duplicatePaths.join() === 'a.txt',
    );
  });

  it('bad JSON or missing groups -> PlanError', () => {
    for (const bad of ['not json', '{}']) {
      assert.throws(() => parsePlan(bad, []), (e: unknown) => e instanceof PlanError && e.unknownPaths.length === 0 && e.duplicatePaths.length === 0);
    }
  });

  it('missing path -> unassigned', () => {
    const plan = parsePlan(ai([{ message: 'a', files: ['a.txt'] }]), [sf('a.txt'), sf('b.txt')]);
    assert.deepEqual(plan.unassigned, ['b.txt']);
  });

  it('origPath reference maps to the new path', () => {
    const plan = parsePlan(ai([{ message: 'a', files: ['a.cs'] }]), [sf('b.cs', { origPath: 'a.cs', change: 'renamed' })]);
    assert.deepEqual(plan.groups[0].files, ['b.cs']);
  });

  it('meta follows asset', () => {
    const scoped = [sf('Foo.cs'), sf('Foo.cs.meta'), sf('x.txt')];
    const plan = pairCompanions(
      parsePlan(ai([{ message: 'a', files: ['Foo.cs'] }, { message: 'b', files: ['Foo.cs.meta', 'x.txt'] }]), scoped),
      scoped,
    );
    assert.deepEqual(plan.groups[0].files, ['Foo.cs', 'Foo.cs.meta']);
    assert.deepEqual(plan.groups[1].files, ['x.txt']);
  });

  it('asset follows meta when asset unassigned; orphan meta stays', () => {
    const scoped = [sf('Foo.cs'), sf('Foo.cs.meta'), sf('Bar.meta')];
    const plan = pairCompanions(parsePlan(ai([{ message: 'a', files: ['Foo.cs.meta', 'Bar.meta'] }]), scoped), scoped);
    assert.deepEqual(plan.groups[0].files, ['Foo.cs.meta', 'Bar.meta', 'Foo.cs']);
    assert.deepEqual(plan.unassigned, []);
  });

  it('rename origPath added in toCommitGroups', () => {
    const scoped = [sf('b.cs', { origPath: 'a.cs', change: 'renamed' })];
    const groups = toCommitGroups(parsePlan(ai([{ message: 'm', files: ['b.cs'] }]), scoped), scoped);
    assert.deepEqual(groups, [{ message: 'm', paths: ['b.cs', 'a.cs'] }]);
  });

  it('locks survive regroup', () => {
    const scoped = [sf('a.txt'), sf('b.txt')];
    const plan = parsePlan(
      ai([{ message: 'ai', files: ['a.txt', 'b.txt'] }]),
      scoped,
      { groups: [{ message: 'mine', files: ['a.txt'] }] },
    );
    assert.equal(plan.groups[0].message, 'mine');
    assert.deepEqual(plan.groups[0].files, ['a.txt']);
    assert.equal(plan.groups[0].locked, true);
    assert.deepEqual(plan.groups.slice(1).flatMap((g) => g.files), ['b.txt']);
  });

  it('AI groups emptied by locks are dropped', () => {
    const scoped = [sf('a.txt')];
    const plan = parsePlan(ai([{ message: 'ai', files: ['a.txt'] }]), scoped, { groups: [{ message: 'mine', files: ['a.txt'] }] });
    assert.equal(plan.groups.length, 1);
  });

  it('unchecked groups excluded from toCommitGroups', () => {
    const scoped = [sf('a.txt'), sf('b.txt')];
    const plan = parsePlan(ai([{ message: 'a', files: ['a.txt'] }, { message: 'b', files: ['b.txt'], uncertain: true }]), scoped);
    assert.deepEqual(toCommitGroups(plan, scoped).map((g) => g.message), ['a']);
  });
});
