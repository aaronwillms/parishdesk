// Plain-Node unit checks for the pure Discernment derivations + access cores.
// Run: node src/discernment/derive.test.mjs   (no DB, no env needed)
import assert from 'node:assert';
import {
  currentStage, mostRecentTransition, nextFollowup, isOverdue, stageRank,
  STARTING_STAGE, vocationLabel, canViewDiscernerCore, canWriteDiscernerCore,
} from './derive.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log('  ✓', name); };

// ── current stage = most recent transition's to_stage ──
ok('currentStage: null with no transitions', () => {
  assert.strictEqual(currentStage([]), null);
  assert.strictEqual(currentStage(undefined), null);
});
ok('currentStage: most recent by transitioned_at wins (out of order)', () => {
  const tr = [
    { id: 'a', to_stage: 'Inquiry',            transitioned_at: '2026-01-01T00:00:00Z' },
    { id: 'c', to_stage: 'Application Submitted', transitioned_at: '2026-03-01T00:00:00Z' },
    { id: 'b', to_stage: 'Active Discernment', transitioned_at: '2026-02-01T00:00:00Z' },
  ];
  assert.strictEqual(currentStage(tr), 'Application Submitted');
  assert.strictEqual(mostRecentTransition(tr).id, 'c');
});
ok('currentStage: id tiebreak when timestamps equal', () => {
  const tr = [
    { id: 'a', to_stage: 'Inquiry',            transitioned_at: '2026-01-01T00:00:00Z' },
    { id: 'z', to_stage: 'Active Discernment', transitioned_at: '2026-01-01T00:00:00Z' },
  ];
  assert.strictEqual(currentStage(tr), 'Active Discernment'); // id 'z' > 'a'
});
ok('currentStage: RECORDED order (created_at) wins over an EARLIER effective date — the stuck-chip bug', () => {
  // Repro: file created today at 22:00Z (Inquiry); user moves stage today, whose
  // transitioned_at is the date at noon-local → 18:00Z, EARLIER than creation.
  // Ordering by transitioned_at would (wrongly) keep "Inquiry"; created_at fixes it.
  const tr = [
    { id: 'a', to_stage: 'Inquiry',            transitioned_at: '2026-06-20T22:00:00Z', created_at: '2026-06-20T22:00:00Z' },
    { id: 'b', to_stage: 'Active Discernment', transitioned_at: '2026-06-20T18:00:00Z', created_at: '2026-06-20T22:05:00Z' },
  ];
  assert.strictEqual(currentStage(tr), 'Active Discernment');
  assert.strictEqual(mostRecentTransition(tr).id, 'b');
});

// ── next contact = soonest incomplete follow-up ──
ok('nextFollowup: null when none open', () => {
  assert.strictEqual(nextFollowup([]), null);
  assert.strictEqual(nextFollowup([{ done: true, due_date: '2026-01-01' }]), null);
  assert.strictEqual(nextFollowup([{ done: false }]), null); // no due_date → ignored
});
ok('nextFollowup: soonest open due_date wins; done ones ignored', () => {
  const fu = [
    { id: '1', done: false, due_date: '2026-09-01' },
    { id: '2', done: true,  due_date: '2026-01-01' }, // done → ignored even though sooner
    { id: '3', done: false, due_date: '2026-06-15' },
  ];
  assert.strictEqual(nextFollowup(fu).id, '3');
});

// ── overdue ──
ok('isOverdue: strictly before today', () => {
  assert.strictEqual(isOverdue('2026-06-19', '2026-06-20'), true);
  assert.strictEqual(isOverdue('2026-06-20', '2026-06-20'), false); // today is not overdue
  assert.strictEqual(isOverdue('2026-06-21', '2026-06-20'), false);
  assert.strictEqual(isOverdue(null, '2026-06-20'), false);
});

// ── misc ──
ok('stageRank: ladder order, unknown last; STARTING_STAGE first', () => {
  assert.strictEqual(stageRank('Inquiry'), 0);
  assert.ok(stageRank('Ordained/Professed') > stageRank('In Seminary/Novitiate'));
  assert.strictEqual(stageRank('Something Legacy'), 999);
  assert.strictEqual(STARTING_STAGE, 'Inquiry');
});
ok('vocationLabel', () => {
  assert.strictEqual(vocationLabel('religious_life'), 'Religious Life');
  assert.strictEqual(vocationLabel('priesthood'), 'Priesthood');
});

// ── access cores — view includes grant path; write excludes it ──
ok('canView: creator / super / panel / grant each suffice', () => {
  assert.strictEqual(canViewDiscernerCore({ isCreator: true }), true);
  assert.strictEqual(canViewDiscernerCore({ isSuper: true }), true);
  assert.strictEqual(canViewDiscernerCore({ hasPanelAccess: true }), true);
  assert.strictEqual(canViewDiscernerCore({ hasGrant: true }), true);
  assert.strictEqual(canViewDiscernerCore({}), false);
});
ok('canWrite: grant alone is NOT enough (%-grantee stays read-only)', () => {
  assert.strictEqual(canWriteDiscernerCore({ hasGrant: true }), false);
  assert.strictEqual(canWriteDiscernerCore({ isCreator: true }), true);
  assert.strictEqual(canWriteDiscernerCore({ isSuper: true }), true);
  assert.strictEqual(canWriteDiscernerCore({ hasPanelAccess: true }), true);
  assert.strictEqual(canWriteDiscernerCore({}), false);
});

console.log(`\n${pass} checks passed.`);
