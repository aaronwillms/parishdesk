// ── Discernment — pure derivation + access-core helpers (no DB imports) ─────
// Everything in here is a pure function of its arguments, so it is unit-testable
// in plain Node (see derive.test.mjs) and carries the snapshot discipline the
// briefing requires: current stage and next contact are DERIVED, never stored.

// ── Stage ladder (SEEDED AS A CONSTANT — parish-editability is deferred) ─────
// The standard arc, in order. Transitions store the stage as frozen TEXT, so
// editing this ladder later never rewrites history.
export const STAGE_LADDER = [
  'Inquiry',
  'Active Discernment',
  'Meeting with Vocations Director',
  'Application Submitted',
  'Accepted to Formation',
  'In Seminary/Novitiate',
];
// Terminal stages — a discernment's possible endings.
export const TERMINAL_STAGES = ['Ordained/Professed', 'Withdrawn', 'Redirected'];
export const ALL_STAGES = [...STAGE_LADDER, ...TERMINAL_STAGES];
export const STARTING_STAGE = STAGE_LADDER[0];

// Per-stage chip palette (matches the app's badge styling language — see
// ociaConfig's STATUS_CHIP_STYLE). Progress stages warm from purple→blue→green;
// terminal stages: Ordained/Professed green, Withdrawn grey, Redirected amber.
export const STAGE_CHIP_STYLE = {
  'Inquiry':                          'background:#EDE9FE;color:#4A1D96;',
  'Active Discernment':               'background:#E0E7FF;color:#3730A3;',
  'Meeting with Vocations Director':  'background:#FEF9E7;color:#7D6608;',
  'Application Submitted':            'background:#FEF3E2;color:#9A5B0E;',
  'Accepted to Formation':            'background:#D6EAF8;color:#1B4F72;',
  'In Seminary/Novitiate':            'background:#D8F3DC;color:#1E6B43;',
  'Ordained/Professed':               'background:#CFF5DE;color:#14532D;',
  'Withdrawn':                        'background:#F2F3F4;color:#616A6B;',
  'Redirected':                       'background:#FBE9D0;color:#7A4B12;',
};
export function stageChipStyle(stage) {
  return STAGE_CHIP_STYLE[stage] || 'background:#F2F3F4;color:#616A6B;';
}
// A stage's position in the full ladder (for sorting the card column by progress).
// Unknown / legacy stages sort last.
export function stageRank(stage) {
  const i = ALL_STAGES.indexOf(stage);
  return i < 0 ? 999 : i;
}

export const VOCATION_TYPES = {
  priesthood:     'Priesthood',
  diaconate:      'Diaconate',
  religious_life: 'Religious Life',
};
export function vocationLabel(t) { return VOCATION_TYPES[t] || t || '—'; }

// ── Snapshot derivations ────────────────────────────────────────────────────
// Current stage = to_stage of the MOST RECENT transition (by transitioned_at,
// id as a stable tiebreak). Returns null when there are no transitions.
export function currentStage(transitions) {
  const t = mostRecentTransition(transitions);
  return t ? t.to_stage : null;
}
export function mostRecentTransition(transitions) {
  if (!Array.isArray(transitions) || !transitions.length) return null;
  return transitions.slice().sort(compareTransitionDesc)[0];
}
// Newest first: later transitioned_at first; tiebreak by id descending so the
// order is deterministic even when two transitions share a timestamp.
export function compareTransitionDesc(a, b) {
  const ta = a.transitioned_at || '', tb = b.transitioned_at || '';
  if (ta !== tb) return tb.localeCompare(ta);
  return String(b.id || '').localeCompare(String(a.id || ''));
}

// Next contact = soonest INCOMPLETE follow-up (MIN due_date WHERE NOT done).
// Returns the follow-up row (or null). Follow-ups without a due_date are ignored
// for "next contact" purposes.
export function nextFollowup(followups) {
  if (!Array.isArray(followups)) return null;
  const open = followups.filter(f => f && !f.done && f.due_date);
  if (!open.length) return null;
  return open.reduce((soonest, f) => (f.due_date < soonest.due_date ? f : soonest));
}
// Overdue = a due date strictly before today (ISO YYYY-MM-DD string compare).
export function isOverdue(dueDate, todayIso) {
  return !!dueDate && !!todayIso && dueDate < todayIso;
}

// ── Access cores (pure) — the live wrappers in the panel feed these the role
// booleans. canView includes the %-grant path; canWrite does NOT (keeps
// %-grantees read-only). Applied to the file AND all child content.
export function canViewDiscernerCore({ isCreator, isSuper, hasPanelAccess, hasGrant }) {
  return !!(isCreator || isSuper || hasPanelAccess || hasGrant);
}
export function canWriteDiscernerCore({ isCreator, isSuper, hasPanelAccess }) {
  return !!(isCreator || isSuper || hasPanelAccess);
}
