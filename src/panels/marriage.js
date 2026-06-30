import { sb, withWriteRetry, serializeWrite, insertWithRetry, deleteWithRetry } from '../supabase.js';
import { fmtDate, formatDateDisplay, todayCST, logActivity, reportWriteError, applyDocCheck, docCheckStampHtml } from '../utils.js';
import { store } from '../store.js';
import { expandCase, ensureCaseDisplays, getCaseDisplay } from './annulments.js';
import { ensureOciaDisplays, getOciaDisplay } from './ocia.js';
import { isAdmin, canAccessSacrament, accessibleParishesForSacrament } from '../roles.js';
import { notifyUsers, getUserIdsForSacrament, notifySacramentEvent } from '../notifications.js';
import { formatPhone, normalizePhone } from '../utils/phone.js';
import { renderSacramentalPanel, refreshActivePanel, openSacramentalRecord, getSelectedParish } from '../sacramental/panelShell.js';
import { shouldShowParishField, parishCreateFieldHtml, resolveCreateParish, parishFieldValid, shouldShowParishFieldEdit, parishEditFieldHtml, readEditParish } from '../sacramental/parishCreateField.js';
import { editNoteLog } from '../sacramental/noteEdit.js';
import { sealGuardConfirm } from '../ui/sealGuard.js';
import { buildPreparerField, readPreparerValue, clergyNames } from '../sacramental/preparerField.js';
import { buildOfficiantField, readOfficiantValue, officiantIsOther } from '../sacramental/officiantField.js';
import { getInstitutionAddress } from '../ui/directory.js';

export const COUPLE_STATUS = {
  inprogress:{ label:'In progress', color:'#7D6608', bg:'#FEF9E7', dot:'#D4AC0D' },
  complete:  { label:'Complete',    color:'#2D6A4F', bg:'#D8F3DC', dot:'#2D6A4F' },
  external:  { label:'External',    color:'#616A6B', bg:'#F2F3F4', dot:'#AAB7B8' },
  inactive:  { label:'Inactive',    color:'#922B21', bg:'#FCEBEB', dot:'#A32D2D' },
};

const MARRIAGE_TYPES = [
  { v:'nuptial_mass',  label:'Nuptial Mass',          badge:'Nuptial Mass' },
  { v:'outside_mass',  label:'Marriage Outside Mass', badge:'Outside Mass' },
  { v:'convalidation', label:'Convalidation',         badge:'Convalidation' },
  { v:'sanatio',       label:'Sanatio in Radice',     badge:'Sanatio' },
];
const MTYPE_BADGE = { nuptial_mass:'Nuptial Mass', outside_mass:'Outside Mass', convalidation:'Convalidation', sanatio:'Sanatio in Radice', external:'External' };
// Required documents auto-added to new files based on each couple's situation (see autoDocList).
// Shown read-only/locked in template editors so admins see the full picture of what will appear.
const MARRIAGE_AUTO_DOCS = [
  'Prenuptial Inquiry',
  'Groom / Bride Baptismal Record (each baptized party)',
  'Permission for Mixed Marriage (if applicable)',
  'Dispensation for Disparity of Cult (if applicable)',
  'Dispensation from Canonical Form (if non-church)',
  'Death Certificate (if a prior marriage ended in death)',
];
const HOW_ENDED = ['Death', 'Annulment', 'Civil Divorce Only'];
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

const FALLBACK_TEMPLATES = {
  nuptial_mass:  { documents:[], steps:[{step:'Initial Meeting'},{step:'Ceremony Planned'}], fees_enabled:true, fees:[{name:'Standard Fee',amount:100}] },
  outside_mass:  { documents:[], steps:[{step:'Initial Meeting'},{step:'Ceremony Planned'}], fees_enabled:true, fees:[{name:'Standard Fee',amount:100}] },
  convalidation: { documents:[{name:'Proof of Civil Marriage',deletable:true}], steps:[{step:'Initial Meeting'},{step:'Ceremony Planned'}], fees_enabled:true, fees:[{name:'Standard Fee',amount:100}] },
  sanatio:       { documents:[], steps:[{step:'Initial Meeting'}], fees_enabled:true, fees:[{name:'Standard Fee',amount:100}] },
  external:      { documents:[], steps:[], fees_enabled:true, fees:[{name:'Standard Fee',amount:100}] },
};

let allCouples = [], coupleFilter = 'all', expandedCoupleId = null;
let _templates = {};   // marriage_type → {documents, steps, fees_enabled, fees}
let _M = null;         // create/edit modal working state
let _marCoordinatorNames = [];   // marriage coordinator display names (preparer source)

function fullAccess() { return isAdmin() || canAccessSacrament('marriage'); }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _curUserName() { return store.currentUserProfile?.personnel?.name || 'Staff'; }
function nowIso() { return new Date().toISOString(); }

// ── Field accessors (backward-compatible) ────────────────────────────────────
// The REAL ceremony type — the SINGLE source of truth for a file's marriage type.
// External is a separate boolean (is_external); the type is NEVER collapsed to
// 'external'. Legacy/corrupted rows that stored marriage_type='external' fall back
// to the default real type (the user can correct it in the edit dialog).
export function marTypeReal(c) {
  const t = c.marriage_type;
  if (!t || t === 'external') return 'nuptial_mass';
  if (MTYPE_BADGE[t]) return t;
  const lt = String(t).toLowerCase();
  if (lt.includes('outside')) return 'outside_mass';
  if (lt.includes('convalid')) return 'convalidation';
  if (lt.includes('sanatio')) return 'sanatio';
  return 'nuptial_mass';
}
function s1Name(c) { return (c.spouse1_first || c.spouse1_last) ? `${c.spouse1_first || ''} ${c.spouse1_last || ''}`.trim() : (c.groom || ''); }
function s2Name(c) { return (c.spouse2_first || c.spouse2_last) ? `${c.spouse2_first || ''} ${c.spouse2_last || ''}`.trim() : (c.bride || ''); }
function coupleLabel(c) { return `${s1Name(c) || '?'} & ${s2Name(c) || '?'}`; }

function normDocs(c) {
  return (c.documents || []).map(d => ({ name: d.name, received: d.received ?? d.done ?? false, deletable: d.deletable ?? !d.auto, auto: !!d.auto, checked_on: d.checked_on || null }));
}
function normSteps(c) { return Array.isArray(c.steps) ? c.steps : []; }
function normFees(c) { return Array.isArray(c.fees) ? c.fees : []; }
function feeTotals(c) {
  const fees = normFees(c);
  if (!fees.length) return null;
  const total = fees.reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const paid = fees.reduce((s, f) => s + (f.paid ? (Number(f.amount) || 0) : 0), 0);
  return { total, paid };
}
function progressOf(c) {
  const docs = normDocs(c), steps = normSteps(c);
  const total = docs.length + steps.length;
  if (!total) return null;
  const done = docs.filter(d => d.received).length + steps.filter(s => s.completed).length;
  return Math.round((done / total) * 100);
}
// "Finalized" = every document received AND every prep step completed (both checkbox
// booleans), INDEPENDENT of status_code. Requires ≥1 doc/step so an empty file isn't
// trivially finalized. Same mechanics as progressOf's done/total.
function _marIsFinalized(c) {
  const docs = normDocs(c), steps = normSteps(c);
  const total = docs.length + steps.length;
  return total > 0 && docs.every(d => d.received) && steps.every(s => s.completed);
}
// Fire the derived "Finalized" event ONCE, on the false→true transition (the last
// missing doc/step just filled). Marriage is cross-linkable → fan out to linked panels.
async function _marMaybeFinalized(c, wasFinalized) {
  if (wasFinalized || !_marIsFinalized(c)) return;
  const { data: { user } } = await sb.auth.getUser();
  notifySacramentEvent({
    keys: ['marriage'], parishId: c.parish_id ?? null, originType: 'marriage', originId: c.id, actorUserId: user?.id,
    message: `${s1Name(c)} & ${s2Name(c)}'s Marriage Preparation File is Finalized`,
    type: 'success', module: 'marriage', record_id: c.id,
  });
}
function notesOf(c) {
  const out = (Array.isArray(c.notes_log) ? c.notes_log : []).map(n => ({ note: n.note || '', by: n.by || null, created_at: n.created_at || null, edited_at: n.edited_at || null }));
  if (c.notes && String(c.notes).trim()) out.push({ note: String(c.notes).trim(), by: null, created_at: null, legacy: true });
  return out;
}
// A visiting/external officiant = the saved officiant is NOT one of the parish
// clergy (a free-text "Other" name), or the legacy officiant_override free-text is
// set. Mirrors the edit form's gating of the Delegation toggle. Exported so the
// viewer (marriageConfig) and the banner share one definition.
export function isVisitingOfficiant(c) {
  const o = officiantOf(c);
  return (!!o && !clergyNames().includes(o)) || !!c.officiant_override;
}
function delegationOutstanding(c) { return isVisitingOfficiant(c) && !c.delegation_given; }

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadTemplates() {
  const { data, error } = await sb.from('marriage_templates').select('marriage_type, documents, steps, fees_enabled, fees');
  _templates = {};
  if (!error && data) data.forEach(r => { _templates[r.marriage_type] = { documents: r.documents || [], steps: r.steps || [], fees_enabled: r.fees_enabled !== false, fees: r.fees || [] }; });
  Object.keys(FALLBACK_TEMPLATES).forEach(k => { if (!_templates[k]) _templates[k] = JSON.parse(JSON.stringify(FALLBACK_TEMPLATES[k])); });
}

async function loadMarriageCoordinator() {
  try {
    const { data } = await sb.from('program_coordinators').select('coordinator_ids').eq('program', 'marriage').eq('parish_id', store.parishSettings?.id).maybeSingle();
    _marCoordinatorNames = (data?.coordinator_ids || []).map(pid => (store.personnel || []).find(p => p.id === pid)?.name).filter(Boolean);
  } catch (_) { _marCoordinatorNames = []; }
}

// Data-only refresh (used by the shell + autosave). Returns the record list.
export async function loadCouplesData() {
  await Promise.all([loadTemplates(), loadMarriageCoordinator()]);
  // Parish-scope: fetch the UNION of parishes this user can access; the in-panel switcher
  // filters per-tab client-side. Single-parish → [home] (≡ old .eq). Fallback to the home
  // parish when the group list is empty (no-group / unresolved).
  const ids = accessibleParishesForSacrament(['marriage']).map(p => p.id);
  let _q = sb.from('couples').select('*');
  if (ids.length) _q = _q.in('parish_id', ids);
  else if (store.parishSettings?.id) _q = _q.eq('parish_id', store.parishSettings.id);
  const { data, error } = await _q;
  if (error) { console.error('[marriage]', error); return []; }
  allCouples = data || [];
  store.allCouples = allCouples;
  // Warm the annulment display cache for every linked prior-marriage case so chips
  // resolve by id without the Annulments panel being loaded.
  await ensureCaseDisplays(allCouples.flatMap(c =>
    [...(c.spouse1_prior_marriages || []), ...(c.spouse2_prior_marriages || [])].map(m => m.annulment_case_id)));
  // Likewise warm the OCIA display cache for every spouse "In OCIA" link, so the
  // OCIA name resolves by id without the OCIA panel being loaded.
  await ensureOciaDisplays(allCouples.flatMap(c => [c.spouse1_ocia_id, c.spouse2_ocia_id]));
  updateCoupleStats();
  renderMarriageAlerts();
  return allCouples;
}

// Nav loader — fetch then mount the master-detail shell into #couples-list.
export async function loadCouples() {
  await loadCouplesData();
  // (The standalone #marriage-gear button was removed with the old chrome; the
  // shell now renders the settings gear via marriageConfig.canManageTemplate.)
  const root = document.getElementById('couples-list');
  if (!root) return;
  const { marriageConfig } = await import('../sacramental/marriageConfig.js');
  renderSacramentalPanel(root, marriageConfig);
}

// ── Shell accessors (consumed by marriageConfig) ─────────────────────────────
export function getCouples() { return allCouples; }
export function getCouple(id) { return allCouples.find(x => x.id === id) || null; }
export { fullAccess as marCanManage };
export { MTYPE_BADGE, coupleLabel, s1Name, s2Name, normDocs, normSteps, normFees, notesOf, progressOf, feeTotals };
export function weddingDateOf(c) { return c?.wedding_date || null; }
export function officiantOf(c) {
  if (c?.officiant) return c.officiant;                                  // new shared-helper value
  if (c?.officiant_id) return (store.personnel || []).find(p => p.id === c.officiant_id)?.name || '';  // legacy FK
  return c?.officiant_override || '';                                    // legacy free-text
}
export function preparerOf(c) { return c?.preparer || ''; }
export function weddingChurch(c) {
  if (c?.wedding_institution_id) return (store.institutions || []).find(i => i.id === c.wedding_institution_id)?.name || '';
  return c?.wedding_church_override || '';
}

// Resolved wedding location for read views / PDF / email. Distinguishes the two
// cases at render time by `wedding_institution_id`:
//   • institution-based → name + address DERIVED from the institution record via
//     getInstitutionAddress (principal resolves to parish_settings inside it);
//     `derived: true`.
//   • "Other location" (or none set) → the file's own name/city/state;
//     `derived: false`.
export function weddingLocation(c) {
  if (c?.wedding_institution_id) {
    const name = (store.institutions || []).find(i => i.id === c.wedding_institution_id)?.name || '';
    const a = getInstitutionAddress(c.wedding_institution_id);
    const lines = [a.street, a.cityStateZip].filter(Boolean);
    return { name, lines, full: [name, ...lines].filter(Boolean).join(', '), derived: true };
  }
  if (c?.wedding_church_override || c?.wedding_city || c?.wedding_state) {
    const csz = [c.wedding_city, c.wedding_state].filter(Boolean).join(', ');
    const name = c.wedding_church_override || '';
    const lines = [csz].filter(Boolean);
    return { name, lines, full: [name, ...lines].filter(Boolean).join(', '), derived: false };
  }
  if (c?.non_church_wedding) return { name: 'Non-church wedding', lines: [], full: 'Non-church wedding', derived: false };
  return { name: '', lines: [], full: '', derived: false };
}

function updateCoupleStats() {
  const active = allCouples.filter(c => !c.archived);
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('stat-couples', active.length);
  set('stat-nearly', active.filter(c => c.status_code === 'complete').length);
  set('stat-needs-attention', active.filter(c => c.status_code === 'inprogress').length);
}

// Priority Actions banner — Marriage-specific (renders into #marriage-alerts).
// State-based rule (no wedding-date thresholds):
//   • ACTIVE files (not archived AND status_code !== 'inactive') surface, per file:
//       - Missing DOCUMENTS (names; NOT steps)
//       - Delegation not given (visiting/external officiant + delegation unchecked)
//       - Records not placed (Wedding Complete checked + records-placement unchecked)
//   • ARCHIVED or INACTIVE files surface ONLY "Records not placed" (Wedding Complete
//     + records unchecked) — the sole banner item that applies to archived files. An
//     archived file where Wedding Complete was never checked stays silent.
// Pure per-file banner items (exported for testability + single source of truth).
// Records-placement now keys on wedding_complete=true AND records_placed=false
// (supersedes the prior status=Complete keying). "Wedding Complete" is NOT a banner
// item itself.
export function marriageAlertItems(c) {
  const archivedOrInactive = !!c.archived || c.status_code === 'inactive';
  const recordsNotPlaced = !!c.wedding_complete && !c.records_placed;
  const items = [];
  if (archivedOrInactive) {
    if (recordsNotPlaced) items.push('Marriage file not yet placed in parish records');
    return items;
  }
  const missingDocs = normDocs(c).filter(d => !d.received).map(d => d.name);
  if (missingDocs.length) items.push('Missing documents: ' + missingDocs.map(_esc).join(', '));
  if (delegationOutstanding(c)) items.push('Delegation not given — send letter of delegation');
  if (recordsNotPlaced) items.push('Marriage file not yet placed in parish records');
  return items;
}
function renderMarriageAlerts() {
  const el = document.getElementById('marriage-alerts'); if (!el) return;
  const blocks = [];
  for (const c of allCouples) {
    const items = marriageAlertItems(c);
    if (items.length) blocks.push({ c, items });
  }
  if (!blocks.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="alert-strip" style="margin-bottom:1rem;flex-direction:column;align-items:flex-start;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><i class="ti ti-alert-triangle" style="color:var(--gold);font-size:15px;"></i><strong style="font-size:13px;">Priority actions</strong></div>
    ${blocks.map(b => `<div style="font-size:13px;color:var(--navy);margin-bottom:5px;">
      <strong>${_esc(coupleLabel(b.c))}</strong>
      ${b.items.map(it => `<div style="margin-left:14px;">· ${it}</div>`).join('')}
    </div>`).join('')}
  </div>`;
}

// Cross-link entry — open a specific marriage file in the shell (deep-link).
export async function expandCouple(id) {
  openSacramentalRecord('marriage', id);   // set hash first so the shell opens it on mount
  window.switchPanel('marriage');
}

// ── Autosave (live card) ─────────────────────────────────────────────────────
async function _patch(coupleId, patch) {
  const c = allCouples.find(x => x.id === coupleId); if (!c) return null;
  // Serialize per-couple so rapid checkbox toggles don't overlap; retry transport failures.
  const { error } = await serializeWrite(`couple:${coupleId}`, () =>
    withWriteRetry(() => sb.from('couples').update({ ...patch, updated_at: nowIso() }).eq('id', coupleId), { kind: 'update' }));
  if (error) { alert('Save failed: ' + error.message); return null; }
  Object.assign(c, patch);
  return c;
}
async function toggleCoupleDoc(coupleId, i) {
  const c = allCouples.find(x => x.id === coupleId); if (!c) return;
  const wasFinalized = _marIsFinalized(c);
  const docs = normDocs(c); applyDocCheck(docs[i], !docs[i].received);
  if (await _patch(coupleId, { documents: docs })) { await _marMaybeFinalized(c, wasFinalized); refreshActivePanel(); }
}
async function toggleCoupleStep(coupleId, i) {
  const c = allCouples.find(x => x.id === coupleId); if (!c) return;
  const wasFinalized = _marIsFinalized(c);
  const steps = JSON.parse(JSON.stringify(normSteps(c)));
  const done = !steps[i].completed;
  steps[i].completed = done;
  steps[i].completed_date = done ? nowIso() : null;
  steps[i].completed_by = done ? _curUserName() : null;
  if (await _patch(coupleId, { steps })) { await _marMaybeFinalized(c, wasFinalized); refreshActivePanel(); }
}
async function toggleCoupleFee(coupleId, i) {
  const c = allCouples.find(x => x.id === coupleId); if (!c) return;
  const fees = JSON.parse(JSON.stringify(normFees(c)));
  fees[i].paid = !fees[i].paid;
  fees[i].paid_date = fees[i].paid ? nowIso() : null;
  if (await _patch(coupleId, { fees })) refreshActivePanel();
}
// Delegation toggle — viewer-editable, non-removable checkbox beside the officiant.
// Routes through the same write-retry-wrapped _patch as the document checkboxes.
async function toggleCoupleDelegation(coupleId) {
  const c = allCouples.find(x => x.id === coupleId); if (!c) return;
  if (await _patch(coupleId, { delegation_given: !c.delegation_given })) refreshActivePanel();
}
// "Wedding Complete" toggle — viewer-editable, non-removable, shown when status is
// Complete; gates records-placement. Unchecking it clears records_placed (gated).
async function toggleCoupleWeddingComplete(coupleId) {
  const c = allCouples.find(x => x.id === coupleId); if (!c) return;
  const next = !c.wedding_complete;
  const patch = next ? { wedding_complete: true } : { wedding_complete: false, records_placed: false };
  if (await _patch(coupleId, patch)) refreshActivePanel();
}
// "Marriage File Placed in Parish Records" toggle — viewer-editable, non-removable,
// shown only once Wedding Complete is checked. Same retry-wrapped write path.
async function toggleCoupleRecordsPlaced(coupleId) {
  const c = allCouples.find(x => x.id === coupleId); if (!c) return;
  if (await _patch(coupleId, { records_placed: !c.records_placed })) refreshActivePanel();
}
async function addCoupleNoteLog(coupleId) {
  const inp = document.getElementById('cn-' + coupleId); const note = (inp?.value || '').trim();
  if (!note) return;
  const c = allCouples.find(x => x.id === coupleId); if (!c) return;
  if (!(await sealGuardConfirm(note))) return;   // shared seal-of-confession guard on the note
  const log = Array.isArray(c.notes_log) ? JSON.parse(JSON.stringify(c.notes_log)) : [];
  log.push({ note, by: _curUserName(), created_at: nowIso() });
  if (await _patch(coupleId, { notes_log: log })) window.flashSavedThen(() => refreshActivePanel());
}
// Edit a notes_log note in place (shared shape): overwrite text + stamp edited_at.
async function coupleEditNoteLog(coupleId, idx) {
  const c = allCouples.find(x => x.id === coupleId); if (!c) return;
  const log = editNoteLog(c.notes_log, idx, nowIso);
  if (!log) return;
  if (!(await sealGuardConfirm(log[idx].note))) return;   // shared seal guard on the edited note
  if (await _patch(coupleId, { notes_log: log })) window.flashSavedThen(() => refreshActivePanel());
}

// ── Big modal scaffolding (own overlay) ──────────────────────────────────────
function _marOverlay() {
  let ov = document.getElementById('mar-overlay');
  if (!ov) {
    ov = document.createElement('div'); ov.id = 'mar-overlay'; ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal anl-modal"><button class="modal-close" onclick="marCloseModal()">×</button><div id="mar-modal-content"></div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) marCloseModal(); });
  }
  return ov;
}
function _marOpen(html) { _marOverlay(); document.getElementById('mar-modal-content').innerHTML = html; document.getElementById('mar-overlay').classList.add('open'); }
function marCloseModal() { document.getElementById('mar-overlay')?.classList.remove('open'); _M = null; }

// ── Small modal helpers ──────────────────────────────────────────────────────
function _row(...cells) { return `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cells.map(c => `<div style="flex:1;min-width:120px;">${c}</div>`).join('')}</div>`; }
function _input(id, label, val = '', type = 'text') { return `<label>${label}</label><input type="${type}" id="${id}" value="${_esc(val)}" />`; }
function _stateSelect(id, val) { return `<label>State</label><select id="${id}"><option value="">—</option>${US_STATES.map(s => `<option${s === val ? ' selected' : ''}>${s}</option>`).join('')}</select>`; }
function _toggle(id, label, on, onchange = '') { return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:.75rem;"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${onchange ? `onchange="${onchange}"` : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" />${label}</label>`; }
function _sectionHead(t) { return `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--cardinal);margin:1.4rem 0 .5rem;border-bottom:.5px solid var(--stone);padding-bottom:4px;">${t}</div>`; }

// ── Create / Edit modal ──────────────────────────────────────────────────────
export async function openCoupleAdd() {
  const type = 'nuptial_mass';
  _M = newModalState(null, type);
  _marOpen(buildCoupleModalHtml(null));
  _hydrateModal();
  marValidateParish();
}

// Parish-field lockout ONLY: disables Save until a parish is chosen when the create
// parish field is shown; a no-op (Save enabled) otherwise. Other required-field checks
// keep their alert-on-submit behavior.
function marValidateParish() {
  const ok = parishFieldValid(['marriage'], 'marriage', 'mar-parish-select');
  const btn = document.getElementById('mar-save');
  if (btn) { btn.disabled = !ok; btn.style.opacity = ok ? '1' : '.5'; btn.style.cursor = ok ? 'pointer' : 'not-allowed'; }
  return ok;
}

function openCoupleEdit(id) {
  const c = allCouples.find(x => x.id === id); if (!c) return;
  _M = newModalState(c, marTypeReal(c));
  _marOpen(buildCoupleModalHtml(c));
  _hydrateModal();
}

function newModalState(c, type) {
  return {
    id: c?.id || null, isEdit: !!c, type, external: !!c?.is_external,
    docs: c ? normDocs(c).filter(d => !d.auto) : (_templates[type]?.documents || []).map(d => ({ name: d.name, received: false, deletable: d.deletable ?? true, auto: false })),
    steps: c ? JSON.parse(JSON.stringify(normSteps(c))) : (_templates[type]?.steps || []).map(s => ({ step: s.step, completed: false })),
    fees: c ? JSON.parse(JSON.stringify(normFees(c))) : (_templates[type]?.fees || []).map(f => ({ name: f.name, amount: f.amount, paid: false })),
    feesEnabled: _templates[type]?.fees_enabled !== false,
    s1: spouseState(c, 1), s2: spouseState(c, 2),
    s1Prior: c?.spouse1_prior_marriages?.length ? JSON.parse(JSON.stringify(c.spouse1_prior_marriages)) : [],
    s2Prior: c?.spouse2_prior_marriages?.length ? JSON.parse(JSON.stringify(c.spouse2_prior_marriages)) : [],
    officiantOther: !c?.officiant_id && !!c?.officiant_override,
    instMode: c?.wedding_institution_id ? 'inst' : (c?.wedding_church_override ? 'other' : ''),
    nonChurch: !!c?.non_church_wedding,
  };
}
function spouseState(c, n) {
  if (!c) return { unbaptized: false, nonCatholic: false, inOcia: false, ocia: null };
  return {
    unbaptized: !!c[`spouse${n}_unbaptized`], nonCatholic: !!c[`spouse${n}_non_catholic`], inOcia: !!c[`spouse${n}_in_ocia`],
    ocia: c[`spouse${n}_ocia_id`] ? { id: c[`spouse${n}_ocia_id`], label: _ociaLabel(c[`spouse${n}_ocia_id`]) } : null,
  };
}
// Resolve by id from the DB-backed OCIA display cache (warmed in loadCouplesData)
// so the spouse "In OCIA" label renders even if the OCIA panel was never opened.
function _ociaLabel(id) { const r = getOciaDisplay(id); return r ? (r.name || 'OCIA record') : 'OCIA record'; }
// Resolve by id from the cross-panel display cache (DB-backed) so the chip label
// renders even if the Annulments panel was never opened. ensureCaseDisplays() is
// called when couples load and on edit-form hydrate, so the cache is warm here.
function _caseLabel(id) { const r = getCaseDisplay(id); return r ? `${r.petitioner || ''}${r.respondent ? ' v. ' + r.respondent : ''}` : 'Annulment case'; }

// ── Cross-panel couple display cache ────────────────────────────────────────
// Annulment records reference couples by id (linked_marriage_prep_id). That label
// must render even if the Marriage panel was never opened this session, so we
// resolve those couples by id DIRECTLY from the DB into a small cache — mirroring
// annulments.js ensureCaseDisplays/getCaseDisplay.
const _coupleDisplayCache = new Map();   // id -> { id, groom, bride }
export async function ensureCoupleDisplays(ids) {
  const want = [...new Set((ids || []).filter(Boolean))];
  if (!want.length) return;
  for (const c of allCouples) if (c?.id) _coupleDisplayCache.set(c.id, c);   // reuse loaded list
  const miss = want.filter(id => !_coupleDisplayCache.has(id));
  if (!miss.length) return;
  const { data } = await sb.from('couples').select('id, groom, bride').in('id', miss);
  (data || []).forEach(r => _coupleDisplayCache.set(r.id, r));
}
// Sync read: cache first, then the panel's in-memory list (either source works).
export function getCoupleDisplay(id) {
  return _coupleDisplayCache.get(id) || allCouples.find(x => x.id === id) || (store.allCouples || []).find(x => x.id === id) || null;
}

function buildCoupleModalHtml(c, opts = {}) {
  const inline = !!opts.inline;
  const isEdit = _M.isEdit;
  const instOpts = (store.institutions || []).map(inst => `<option value="${inst.id}"${c?.wedding_institution_id === inst.id ? ' selected' : ''}>${_esc(inst.name)}</option>`).join('');

  let h = inline ? '' : `<div class="modal-title">${isEdit ? 'Edit Marriage File' : 'New Marriage File'}</div>`;

  // Parish picker. CREATE (All tab, >1 parish): placeholder + Save-lockout. EDIT (>1
  // parish): the record's parish preselected, reassignable, NO lockout. Distinct ids.
  if ((!isEdit && !inline) && shouldShowParishField(['marriage'], 'marriage')) {
    h += parishCreateFieldHtml(['marriage'], { selectId: 'mar-parish-select', onChange: 'marValidateParish()' });
  } else if (isEdit && shouldShowParishFieldEdit(['marriage'])) {
    h += parishEditFieldHtml(['marriage'], { selectId: 'mar-parish-edit', currentParishId: c?.parish_id || null });
  }

  // Section 1 — Person responsible for formation (clergy + marriage coordinator + Other) + External
  // Marriage panel uses context-dependent labels for this ONE field (same value/
  // column): add/edit dialogs say "…for Marriage Preparation"; the viewer (see
  // marriageConfig fileDetails) uses the short "Marriage Prep" for alignment.
  h += _sectionHead('Person Responsible for Marriage Preparation');
  h += buildPreparerField('mf-preparer', c?.preparer || '', { coordinatorNames: _marCoordinatorNames, label: 'Person Responsible for Marriage Preparation' });

  h += _toggle('mf-external', 'External (preparation handled elsewhere)', _M.external, 'marOnExternalToggle()');

  // Section 2 — Marriage type (kept for external — type still matters for record keeping)
  h += _sectionHead('Marriage Type');
  h += `<div id="mf-type-wrap" style="display:block;">
    <label>Type</label><select id="mf-type" onchange="marOnTypeChange(this.value)">${MARRIAGE_TYPES.map(t => `<option value="${t.v}"${_M.type === t.v ? ' selected' : ''}>${t.label}</option>`).join('')}</select>
    <div id="mf-sanatio-note" class="anl-info-box" style="display:${_M.type === 'sanatio' ? 'block' : 'none'};">Sanatio in Radice does not require consent to be exchanged again.</div>
    <div id="mf-civil-wrap" style="display:${(_M.type === 'convalidation' || _M.type === 'sanatio') ? 'block' : 'none'};">${_input('mf-civil-date', 'Civil Marriage Date', c?.civil_marriage_date || '', 'date')}</div>
    <div id="mf-faculty-wrap" style="display:${_M.type === 'sanatio' ? 'block' : 'none'};">${_input('mf-faculty', 'Faculty Granted By', c?.sanatio_faculty || '')}</div>
  </div>`;

  // Section 3 / 4 — Spouses
  h += renderSpouseSection(c, 1);
  h += renderSpouseSection(c, 2);

  // Section 5 — Wedding details (kept for external)
  h += `<div id="mf-wedding-section" style="display:block;">`;
  h += _sectionHead('Wedding Details');
  h += _input('mf-wd', 'Date of Marriage', c?.wedding_date || '', 'date');
  h += _toggle('mf-nonchurch', 'Non-Church Wedding?', _M.nonChurch, 'marOnNonChurchToggle()');
  h += `<div id="mf-time-wrap" style="display:${_M.nonChurch ? 'none' : 'block'};">${_input('mf-wt', 'Time of Marriage', c?.wedding_time || '', 'text')}</div>`;
  // Church of Marriage. An institution-based location DERIVES its address from the
  // institution record (read-only, via getInstitutionAddress) — the file stores
  // only wedding_institution_id, never a per-file copy. "Other location…" is the
  // one case the file keeps its own free-text address (name/city/state).
  h += `<label>Church of Marriage</label>
    <select id="mf-inst" onchange="marOnInstitutionChange(this.value)">
      <option value="">— Select —</option>${instOpts}<option value="__other"${_M.instMode === 'other' ? ' selected' : ''}>Other location…</option>
    </select>
    <div id="mf-inst-addr" style="display:${_M.instMode === 'inst' ? 'block' : 'none'};">${_instAddrBlock(c?.wedding_institution_id)}</div>
    <div id="mf-other-wrap" style="display:${_M.instMode === 'other' ? 'block' : 'none'};">
      ${_input('mf-church-override', 'Location name', c?.wedding_church_override || '')}
      ${_row(_input('mf-wcity', 'City', c?.wedding_city || ''), _stateSelect('mf-wstate', c?.wedding_state || ''))}
    </div>`;
  // Officiant — shared clergy dropdown (institution clergy + Other). Seeded from
  // the new column or the legacy officiant_id/_override so saved values persist.
  const offValue = officiantOf(c);
  const offIsOther = !!offValue && !clergyNames().includes(offValue);
  h += `<div style="margin-top:.75rem;">`;
  h += buildOfficiantField('mf-officiant', offValue, { onOtherChange: 'marOnOfficiantOtherToggle()' });
  h += `<div id="mf-delegation-wrap" style="display:${offIsOther ? 'block' : 'none'};">${_toggle('mf-delegation', 'Delegation Given?', !!c?.delegation_given)}</div>`;
  h += `</div>`;
  h += `</div>`;

  // Section 6 — Documents (hidden if external)
  h += `<div id="mf-docs-section" style="display:${_M.external ? 'none' : 'block'};">`;
  h += _sectionHead('Required Documents');
  h += `<div id="mf-docs"></div>
    <div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="mf-doc-new" placeholder="Add document…" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();marAddDoc();}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="marAddDoc()">+ Add</button></div>`;
  h += `</div>`;

  // Section 7 — Steps (hidden if external)
  h += `<div id="mf-steps-section" style="display:${_M.external ? 'none' : 'block'};">`;
  h += _sectionHead('Steps of Preparation');
  h += `<div id="mf-steps"></div>
    <div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="mf-step-new" placeholder="Add step…" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();marAddStep();}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="marAddStep()">+ Add</button></div>`;
  h += `</div>`;

  // Section 8 — Fees (always)
  h += _sectionHead('Fees');
  h += `<div id="mf-fees"></div>
    <div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="mf-fee-name" placeholder="Fee name…" style="flex:2;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" /><input type="number" id="mf-fee-amt" placeholder="$" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="marAddFee()">+ Add</button></div>
    <div id="mf-fee-total" style="font-size:12px;color:#5B4636;margin-top:6px;"></div>`;

  // Status — shown in BOTH Add and Edit (default "In progress") so an already-
  // complete paper file can be back-entered at any status. Archive stays edit-only.
  // 'external' is NOT a selectable status — it's the is_external toggle below.
  // Status choices are only In Progress / Complete / Inactive.
  const curStatus = (c?.status_code && c.status_code !== 'external') ? c.status_code : 'inprogress';
  h += _sectionHead('Status');
  h += `<label>Status</label><select id="mf-status" onchange="marOnStatusChange()">${Object.entries(COUPLE_STATUS).filter(([k]) => k !== 'external').map(([k, v]) => `<option value="${k}"${curStatus === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`;
  // Completion chain: status Complete → "Wedding Complete" → (when checked) the
  // "Marriage File Placed in Parish Records" toggle nests under it.
  const isComplete = curStatus === 'complete';
  h += `<div id="mf-weddingcomplete-wrap" style="display:${isComplete ? 'block' : 'none'};">
    ${_toggle('mf-wedding-complete', 'Wedding Complete', !!c?.wedding_complete, 'marOnWeddingCompleteToggle()')}
    <div id="mf-records-wrap" style="display:${(isComplete && c?.wedding_complete) ? 'block' : 'none'};margin-left:1.5rem;">
      ${_toggle('mf-records-placed', 'Marriage File Placed in Parish Records', !!c?.records_placed)}
    </div>
  </div>`;
  if (isEdit) h += _toggle('mf-archive', 'Archive this file', !!c?.archived);

  if (!inline) {
    h += `<div class="modal-actions" style="justify-content:space-between;">
      ${isEdit ? `<button class="btn-delete" onclick="marDeleteCouple('${_M.id}')">Delete</button>` : '<span></span>'}
      <div style="display:flex;gap:8px;"><button class="btn-secondary" onclick="marCloseModal()">Cancel</button><button class="btn-primary" id="mar-save" onclick="marSaveCouple()">${isEdit ? 'Save' : 'Create File'}</button></div>
    </div>`;
  }
  return h;
}

function renderSpouseSection(c, n) {
  const s = _M[`s${n}`];
  const p = n === 1 ? 's1' : 's2';
  let h = _sectionHead(n === 1 ? 'Groom' : 'Bride');
  h += _row(_input(`mf-${p}-first`, 'First Name', c?.[`spouse${n}_first`] || ''), _input(`mf-${p}-middle`, 'Middle', c?.[`spouse${n}_middle`] || ''), _input(`mf-${p}-last`, 'Last Name', c?.[`spouse${n}_last`] || ''));
  h += _row(_input(`mf-${p}-cell`, 'Cell Phone', c?.[`${n === 1 ? 'groom' : 'bride'}_phone`] || '', 'tel'), _input(`mf-${p}-email`, 'Email', c?.[`${n === 1 ? 'groom' : 'bride'}_email`] || ''));
  // Per-party PREP fields (DOB, baptism place, prior marriages) are hidden when the
  // file is External — preparation handled elsewhere. Same is_external gating as the
  // delegation field; data is preserved (display-only), never cleared.
  h += `<div id="mf-${p}-dob-wrap" style="display:${_M.external ? 'none' : 'block'};">${_input(`mf-${p}-dob`, 'Date of Birth', c?.[`spouse${n}_dob`] || '', 'date')}</div>`;
  h += _toggle(`mf-${p}-unbap`, 'Unbaptized?', s.unbaptized, `marSpouseToggle(${n})`);
  h += `<div id="mf-${p}-noncath-wrap" style="display:${s.unbaptized ? 'none' : 'block'};">${_toggle(`mf-${p}-noncath`, 'Non-Catholic?', s.nonCatholic, `marSpouseToggle(${n})`)}</div>`;
  h += `<div id="mf-${p}-ocia-wrap" style="display:${(s.unbaptized || s.nonCatholic) ? 'block' : 'none'};">
    ${_toggle(`mf-${p}-inocia`, 'In OCIA?', s.inOcia, `marSpouseToggle(${n})`)}
    <div id="mf-${p}-ociasearch-wrap" style="display:${s.inOcia ? 'block' : 'none'};position:relative;">
      <input type="text" id="mf-${p}-ocia" placeholder="Search OCIA by name…" autocomplete="off" oninput="marOciaSearch(${n})" style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;margin-top:6px;" />
      <div id="mf-${p}-ocia-results" class="anl-link-results" style="display:none;"></div>
      <div id="mf-${p}-ocia-chip" style="margin-top:6px;"></div>
    </div>
  </div>`;
  h += `<div id="mf-${p}-baptism-wrap" style="display:${(_M.external || s.unbaptized) ? 'none' : 'block'};">${_row(_input(`mf-${p}-bchurch`, 'Church of Baptism', c?.[`spouse${n}_baptism_church`] || ''), _input(`mf-${p}-bcity`, 'City', c?.[`spouse${n}_baptism_city`] || ''), _input(`mf-${p}-bstate`, 'State/Country', c?.[`spouse${n}_baptism_state`] || ''))}${_input(`mf-${p}-bdate`, 'Date of Baptism', (c?.[`spouse${n}_baptism_date`] && /^\d{4}-\d{2}-\d{2}/.test(c[`spouse${n}_baptism_date`])) ? c[`spouse${n}_baptism_date`].slice(0, 10) : '', 'date')}${_toggle(`mf-${p}-baffidavit`, 'By Affidavit', !!c?.[`spouse${n}_baptism_by_affidavit`])}</div>`;
  // Prior marriages (hidden for External)
  h += `<div id="mf-${p}-prior-block" style="display:${_M.external ? 'none' : 'block'};margin-top:.75rem;">${_toggle(`mf-${p}-priortoggle`, 'Prior Marriage?', _M[`${p}Prior`].length > 0, `marPriorToggle(${n})`)}
    <div id="mf-${p}-prior-wrap" style="display:${_M[`${p}Prior`].length > 0 ? 'block' : 'none'};margin-top:.5rem;"></div></div>`;
  return h;
}

// ── Modal dynamic renders ────────────────────────────────────────────────────
function _hydrateModal() {
  renderModalDocs(); renderModalSteps(); renderModalFees();
  renderPrior(1); renderPrior(2);
  renderOciaChip(1); renderOciaChip(2);
}

function autoDocList() {
  if (_M.external) return [];
  const docs = [];
  docs.push({ name: 'Prenuptial Inquiry', auto: true, deletable: false });
  const s1u = _M.s1.unbaptized, s2u = _M.s2.unbaptized, s1nc = _M.s1.nonCatholic, s2nc = _M.s2.nonCatholic;
  if (!s1u) docs.push({ name: 'Groom Baptismal Record', auto: true, deletable: false, baptism: 1 });
  if (!s2u) docs.push({ name: 'Bride Baptismal Record', auto: true, deletable: false, baptism: 2 });
  if (((s1nc && !s2nc) || (s2nc && !s1nc)) && !s1u && !s2u) docs.push({ name: 'Permission for Mixed Marriage', auto: true, deletable: false });
  if (s1u || s2u) docs.push({ name: 'Dispensation for Disparity of Cult', auto: true, deletable: false });
  if (_M.nonChurch) docs.push({ name: 'Dispensation from Canonical Form', auto: true, deletable: false });
  if (_M.s1Prior.some(p => p.how_ended === 'Death')) docs.push({ name: 'Death Certificate (Spouse 1)', auto: true, deletable: false });
  if (_M.s2Prior.some(p => p.how_ended === 'Death')) docs.push({ name: 'Death Certificate (Spouse 2)', auto: true, deletable: false });
  return docs;
}
function renderModalDocs() {
  const el = document.getElementById('mf-docs'); if (!el) return;
  const autos = autoDocList();
  const bInfo = (n) => {
    const ch = document.getElementById(`mf-s${n}-bchurch`)?.value || '';
    const ci = document.getElementById(`mf-s${n}-bcity`)?.value || '';
    const st = document.getElementById(`mf-s${n}-bstate`)?.value || '';
    const parts = [ch, ci, st].filter(Boolean).join(', ');
    return parts ? `<div style="font-size:11px;color:#9CA3AF;margin-left:24px;">${_esc(parts)}</div>` : '';
  };
  const autoHtml = autos.map(d => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
      <i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;width:15px;text-align:center;"></i>
      <span style="flex:1;font-size:13px;color:var(--navy);">${_esc(d.name)}</span><span style="font-size:10.5px;color:#9CA3AF;">auto</span>
    </div>${d.baptism ? bInfo(d.baptism) : ''}`).join('');
  const customHtml = _M.docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
      <input type="checkbox" ${d.received ? 'checked' : ''} onchange="marDocReceived(${i},this.checked)" style="width:15px;height:15px;accent-color:var(--cardinal);" />
      <span style="font-size:13px;color:var(--navy);">${_esc(d.name)}</span>
      ${docCheckStampHtml(d)}
      <button onclick="marRemoveDoc(${i})" title="Remove" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;margin-left:8px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>
    </div>`).join('');
  el.innerHTML = autoHtml + customHtml || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No documents.</div>`;
}
function renderModalSteps() {
  const el = document.getElementById('mf-steps'); if (!el) return;
  el.innerHTML = _M.steps.map((s, i) => `<div draggable="true" ondragstart="marStepDragStart(${i})" ondragover="event.preventDefault()" ondrop="marStepDrop(${i})" style="display:flex;align-items:center;gap:8px;padding:3px 0;">
      <span style="cursor:grab;color:#C9C2B6;font-size:13px;"><i class="fa-solid fa-grip-vertical"></i></span>
      <span style="flex:1;font-size:13px;color:var(--navy);">${_esc(s.step)}</span>
      <button onclick="marRemoveStep(${i})" title="Remove" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>
    </div>`).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No steps.</div>`;
}
function renderModalFees() {
  const el = document.getElementById('mf-fees'); if (!el) return;
  el.innerHTML = _M.fees.map((f, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
      <input type="checkbox" ${f.paid ? 'checked' : ''} onchange="marFeePaid(${i},this.checked)" style="width:15px;height:15px;accent-color:var(--cardinal);" title="Paid" />
      <span style="flex:1;font-size:13px;color:var(--navy);">${_esc(f.name)}</span>
      <span style="font-size:12px;color:#5B4636;">$${Number(f.amount) || 0}</span>
      <button onclick="marRemoveFee(${i})" title="Remove" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>
    </div>`).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No fees.</div>`;
  const total = _M.fees.reduce((s, f) => s + (Number(f.amount) || 0), 0);
  const paid = _M.fees.reduce((s, f) => s + (f.paid ? (Number(f.amount) || 0) : 0), 0);
  const tot = document.getElementById('mf-fee-total'); if (tot) tot.textContent = `$${total} total / $${paid} paid`;
}
function renderPrior(n) {
  const p = n === 1 ? 's1' : 's2';
  const wrap = document.getElementById(`mf-${p}-prior-wrap`); if (!wrap) return;
  const list = _M[`${p}Prior`];
  wrap.innerHTML = list.map((pm, i) => `<div style="background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.6rem;margin-bottom:.5rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><span style="font-size:12px;font-weight:600;color:#555;">Prior marriage ${i + 1}</span><button onclick="marRemovePrior(${n},${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:12px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">× Remove</button></div>
      ${_input(`mf-${p}-pm-name-${i}`, 'Prior spouse name', pm.spouse_name || '')}
      <label>How ended</label><select id="mf-${p}-pm-ended-${i}" onchange="marPriorEndedChange(${n},${i},this.value)">${HOW_ENDED.map(o => `<option${pm.how_ended === o ? ' selected' : ''}>${o}</option>`).join('')}</select>
      <div id="mf-${p}-pm-annul-${i}" style="display:${pm.how_ended === 'Annulment' ? 'block' : 'none'};position:relative;">
        <input type="text" id="mf-${p}-pm-annulsearch-${i}" placeholder="Link annulment case…" autocomplete="off" oninput="marAnnulSearch(${n},${i})" style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;margin-top:6px;" />
        <div id="mf-${p}-pm-annulresults-${i}" class="anl-link-results" style="display:none;"></div>
        <div id="mf-${p}-pm-annulchip-${i}" style="margin-top:6px;">${pm.annulment_case_id ? annulChipHtml(n, i, pm.annulment_case_id) : ''}</div>
      </div>
    </div>`).join('') + `<button class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;" onclick="marAddPrior(${n})">+ Add prior marriage</button>`;
}
function annulChipHtml(n, i, caseId) {
  return `<span style="display:inline-flex;align-items:center;gap:8px;background:#1C2B3A;color:#fff;border-radius:14px;padding:3px 8px 3px 12px;font-size:12px;"><span>${_esc(_caseLabel(caseId))}</span><button onclick="window.expandCase('${caseId}')" title="Open" style="background:none;border:none;color:#C9A84C;cursor:pointer;font-size:11px;padding:0;"><i class="fa-solid fa-arrow-up-right-from-square"></i></button><button onclick="marRemoveAnnul(${n},${i})" title="Unlink" style="background:none;border:none;color:#cdd6df;cursor:pointer;font-size:12px;padding:0;">×</button></span>`;
}
function renderOciaChip(n) {
  const p = n === 1 ? 's1' : 's2';
  const el = document.getElementById(`mf-${p}-ocia-chip`); if (!el) return;
  const link = _M[`s${n}`].ocia;
  el.innerHTML = link ? `<span style="display:inline-flex;align-items:center;gap:8px;background:#1C2B3A;color:#fff;border-radius:14px;padding:3px 8px 3px 12px;font-size:12px;"><span>${_esc(link.label)}</span><button onclick="window.expandOcia('${link.id}')" title="Open" style="background:none;border:none;color:#C9A84C;cursor:pointer;font-size:11px;padding:0;"><i class="fa-solid fa-arrow-up-right-from-square"></i></button><button onclick="marRemoveOcia(${n})" title="Unlink" style="background:none;border:none;color:#cdd6df;cursor:pointer;font-size:12px;padding:0;">×</button></span>` : '';
}

// ── Modal handlers ───────────────────────────────────────────────────────────
function marOnExternalToggle() {
  _M.external = document.getElementById('mf-external').checked;
  // External removes Documents + Steps of Preparation AND the per-party prep fields
  // (DOB, baptism place, prior marriages); Type, Wedding Details, Fees stay.
  ['mf-docs-section', 'mf-steps-section'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = _M.external ? 'none' : 'block'; });
  [1, 2].forEach(n => {
    const p = n === 1 ? 's1' : 's2';
    const s = _M[`s${n}`];
    const dob = document.getElementById(`mf-${p}-dob-wrap`); if (dob) dob.style.display = _M.external ? 'none' : 'block';
    const prior = document.getElementById(`mf-${p}-prior-block`); if (prior) prior.style.display = _M.external ? 'none' : 'block';
    const bap = document.getElementById(`mf-${p}-baptism-wrap`); if (bap) bap.style.display = (_M.external || s.unbaptized) ? 'none' : 'block';
  });
}
function marOnTypeChange(v) {
  _M.type = v;
  document.getElementById('mf-sanatio-note').style.display = v === 'sanatio' ? 'block' : 'none';
  document.getElementById('mf-civil-wrap').style.display = (v === 'convalidation' || v === 'sanatio') ? 'block' : 'none';
  document.getElementById('mf-faculty-wrap').style.display = v === 'sanatio' ? 'block' : 'none';
  if (!_M.isEdit) {
    const t = _templates[v] || FALLBACK_TEMPLATES[v];
    _M.docs = (t.documents || []).map(d => ({ name: d.name, received: false, deletable: d.deletable ?? true, auto: false }));
    _M.steps = (t.steps || []).map(s => ({ step: s.step, completed: false }));
    _M.fees = (t.fees || []).map(f => ({ name: f.name, amount: f.amount, paid: false }));
    renderModalDocs(); renderModalSteps(); renderModalFees();
  }
}
function marOnNonChurchToggle() {
  _M.nonChurch = document.getElementById('mf-nonchurch').checked;
  document.getElementById('mf-time-wrap').style.display = _M.nonChurch ? 'none' : 'block';
  renderModalDocs();
}
function marOnInstitutionChange(v) {
  _M.instMode = v === '__other' ? 'other' : (v ? 'inst' : '');
  const otherWrap = document.getElementById('mf-other-wrap');
  const addrBox = document.getElementById('mf-inst-addr');
  if (otherWrap) otherWrap.style.display = _M.instMode === 'other' ? 'block' : 'none';
  if (addrBox) {
    addrBox.style.display = _M.instMode === 'inst' ? 'block' : 'none';
    addrBox.innerHTML = _M.instMode === 'inst' ? _instAddrBlock(v) : '';
  }
}
// Read-only address DERIVED from the institution record — single source of truth
// via getInstitutionAddress (which resolves the principal to parish_settings
// internally; the file stays agnostic and stores no per-file copy).
function _instAddrBlock(instId) {
  if (!instId) return '';
  const a = getInstitutionAddress(instId);
  const body = a.has
    ? [a.street, a.cityStateZip].filter(Boolean).map(l => `<div>${_esc(l)}</div>`).join('')
    : `<div style="font-style:italic;color:#9CA3AF;">No address on file — set it in the Directory (institution settings).</div>`;
  return `<div style="background:#F0EDE8;border-radius:6px;padding:.5rem .7rem;margin-top:.4rem;font-size:12.5px;color:#4B5563;line-height:1.5;">
    <div style="font-size:10.5px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.05em;margin-bottom:2px;">Address (from institution record)</div>
    ${body}
  </div>`;
}
// Show the Delegation toggle only when the officiant is a free-text "Other".
function marOnOfficiantOtherToggle() { const w = document.getElementById('mf-delegation-wrap'); if (w) w.style.display = officiantIsOther('mf-officiant') ? 'block' : 'none'; }
function marOnStatusChange() {
  const v = document.getElementById('mf-status')?.value;
  const wc = document.getElementById('mf-weddingcomplete-wrap'); if (wc) wc.style.display = v === 'complete' ? 'block' : 'none';
  _syncRecordsWrap();
}
function marOnWeddingCompleteToggle() { _syncRecordsWrap(); }
function _syncRecordsWrap() {
  const complete = document.getElementById('mf-status')?.value === 'complete';
  const weddingDone = !!document.getElementById('mf-wedding-complete')?.checked;
  const rw = document.getElementById('mf-records-wrap');
  if (rw) rw.style.display = (complete && weddingDone) ? 'block' : 'none';
}

function marSpouseToggle(n) {
  const p = n === 1 ? 's1' : 's2';
  const s = _M[`s${n}`];
  s.unbaptized = document.getElementById(`mf-${p}-unbap`).checked;
  s.nonCatholic = document.getElementById(`mf-${p}-noncath`)?.checked || false;
  s.inOcia = document.getElementById(`mf-${p}-inocia`)?.checked || false;
  document.getElementById(`mf-${p}-noncath-wrap`).style.display = s.unbaptized ? 'none' : 'block';
  document.getElementById(`mf-${p}-baptism-wrap`).style.display = (_M.external || s.unbaptized) ? 'none' : 'block';
  document.getElementById(`mf-${p}-ocia-wrap`).style.display = (s.unbaptized || s.nonCatholic) ? 'block' : 'none';
  document.getElementById(`mf-${p}-ociasearch-wrap`).style.display = s.inOcia ? 'block' : 'none';
  renderModalDocs();
}
function marPriorToggle(n) {
  const p = n === 1 ? 's1' : 's2';
  const on = document.getElementById(`mf-${p}-priortoggle`).checked;
  document.getElementById(`mf-${p}-prior-wrap`).style.display = on ? 'block' : 'none';
  if (on && !_M[`${p}Prior`].length) { _M[`${p}Prior`] = [{ spouse_name: '', how_ended: 'Death', annulment_case_id: null, death_cert_required: true }]; renderPrior(n); renderModalDocs(); }
}
function _syncPriorFromDom(n) {
  const p = n === 1 ? 's1' : 's2';
  _M[`${p}Prior`] = _M[`${p}Prior`].map((pm, i) => ({
    spouse_name: document.getElementById(`mf-${p}-pm-name-${i}`)?.value.trim() || '',
    how_ended: document.getElementById(`mf-${p}-pm-ended-${i}`)?.value || 'Death',
    annulment_case_id: pm.annulment_case_id || null,
    death_cert_required: (document.getElementById(`mf-${p}-pm-ended-${i}`)?.value || pm.how_ended) === 'Death',
  }));
}
function marAddPrior(n) { _syncPriorFromDom(n); const p = n === 1 ? 's1' : 's2'; _M[`${p}Prior`].push({ spouse_name: '', how_ended: 'Death', annulment_case_id: null, death_cert_required: true }); renderPrior(n); renderModalDocs(); }
function marRemovePrior(n, i) { _syncPriorFromDom(n); const p = n === 1 ? 's1' : 's2'; _M[`${p}Prior`].splice(i, 1); renderPrior(n); renderModalDocs(); }
function marPriorEndedChange(n, i, v) {
  const p = n === 1 ? 's1' : 's2';
  document.getElementById(`mf-${p}-pm-annul-${i}`).style.display = v === 'Annulment' ? 'block' : 'none';
  _syncPriorFromDom(n); renderModalDocs();
}

// link searches
async function _linkSearch(boxId, table, cols, mapper, q) {
  const box = document.getElementById(boxId); if (!box) return;
  if ((q || '').trim().length < 2) { box.style.display = 'none'; return; }
  const safe = q.replace(/[%_,()'"*]/g, ' ');
  let qb = sb.from(table).select('*');
  qb = cols.length > 1 ? qb.or(cols.map(c => `${c}.ilike.%${safe}%`).join(',')) : qb.ilike(cols[0], `%${safe}%`);
  const { data } = await qb.limit(6);
  const rows = (data || []).map(mapper);
  box.innerHTML = rows.length ? rows.map(r => `<div class="anl-link-opt" data-id="${r.id}" data-label="${_esc(r.label).replace(/"/g, '&quot;')}">${_esc(r.label)}</div>`).join('') : `<div style="padding:.5rem .7rem;font-size:12px;color:#9CA3AF;">No matches</div>`;
  box.style.display = 'block';
  return box;
}
async function marOciaSearch(n) {
  const p = n === 1 ? 's1' : 's2';
  const q = document.getElementById(`mf-${p}-ocia`)?.value || '';
  const box = await _linkSearch(`mf-${p}-ocia-results`, 'sacramental_ocia', ['name'], r => ({ id: r.id, label: r.name || 'OCIA record' }), q);
  box?.querySelectorAll('.anl-link-opt').forEach(o => o.addEventListener('mousedown', e => { e.preventDefault(); _M[`s${n}`].ocia = { id: o.dataset.id, label: o.dataset.label }; _M[`s${n}`].inOcia = true; box.style.display = 'none'; document.getElementById(`mf-${p}-ocia`).value = ''; renderOciaChip(n); }));
}
function marRemoveOcia(n) { _M[`s${n}`].ocia = null; renderOciaChip(n); }
async function marAnnulSearch(n, i) {
  const p = n === 1 ? 's1' : 's2';
  const q = document.getElementById(`mf-${p}-pm-annulsearch-${i}`)?.value || '';
  const box = await _linkSearch(`mf-${p}-pm-annulresults-${i}`, 'annulment_cases', ['petitioner', 'respondent'], r => ({ id: r.id, label: `${r.petitioner || ''}${r.respondent ? ' v. ' + r.respondent : ''}` }), q);
  box?.querySelectorAll('.anl-link-opt').forEach(o => o.addEventListener('mousedown', e => { e.preventDefault(); _syncPriorFromDom(n); _M[`${p}Prior`][i].annulment_case_id = o.dataset.id; box.style.display = 'none'; document.getElementById(`mf-${p}-pm-annulchip-${i}`).innerHTML = annulChipHtml(n, i, o.dataset.id); }));
}
function marRemoveAnnul(n, i) { const p = n === 1 ? 's1' : 's2'; _syncPriorFromDom(n); _M[`${p}Prior`][i].annulment_case_id = null; document.getElementById(`mf-${p}-pm-annulchip-${i}`).innerHTML = ''; }

function marDocReceived(i, v) { applyDocCheck(_M.docs[i], v); renderModalDocs(); }
function marRemoveDoc(i) { _M.docs.splice(i, 1); renderModalDocs(); }
function marAddDoc() { const inp = document.getElementById('mf-doc-new'); const name = (inp?.value || '').trim(); if (!name) return; _M.docs.push({ name, received: false, deletable: true, auto: false }); inp.value = ''; renderModalDocs(); }
function marAddStep() { const inp = document.getElementById('mf-step-new'); const step = (inp?.value || '').trim(); if (!step) return; _M.steps.push({ step, completed: false }); inp.value = ''; renderModalSteps(); }
function marRemoveStep(i) { _M.steps.splice(i, 1); renderModalSteps(); }
let _stepDrag = null;
function marStepDragStart(i) { _stepDrag = i; }
function marStepDrop(i) { if (_stepDrag === null || _stepDrag === i) return; const it = _M.steps.splice(_stepDrag, 1)[0]; _M.steps.splice(i, 0, it); _stepDrag = null; renderModalSteps(); }
function marAddFee() { const nm = document.getElementById('mf-fee-name'); const am = document.getElementById('mf-fee-amt'); const name = (nm?.value || '').trim(); if (!name) return; _M.fees.push({ name, amount: Number(am?.value) || 0, paid: false }); nm.value = ''; am.value = ''; renderModalFees(); }
function marRemoveFee(i) { _M.fees.splice(i, 1); renderModalFees(); }
function marFeePaid(i, v) { _M.fees[i].paid = v; _M.fees[i].paid_date = v ? nowIso() : null; renderModalFees(); }

// ── Save ─────────────────────────────────────────────────────────────────────
function _v(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function _chk(id) { return !!document.getElementById(id)?.checked; }

// Shared DOM→payload reader, used by the create modal AND the shell inline edit.
function _marReadPayload() {
  _syncPriorFromDom(1); _syncPriorFromDom(2);
  const external = _M.external;
  const instSel = document.getElementById('mf-inst')?.value || '';
  const s1first = _v('mf-s1-first'), s1last = _v('mf-s1-last'), s2first = _v('mf-s2-first'), s2last = _v('mf-s2-last');

  // merge auto docs + custom docs (preserve received on existing autos when editing)
  const prior = _M.isEdit ? allCouples.find(c => c.id === _M.id) : null;
  const priorDocs = prior ? normDocs(prior) : [];
  const finalDocs = external ? (prior ? prior.documents || [] : []) : [
    ...autoDocList().map(d => { const ex = priorDocs.find(x => x.name === d.name); return { name: d.name, received: ex?.received || false, deletable: false, auto: true }; }),
    ..._M.docs.map(d => ({ name: d.name, received: !!d.received, deletable: d.deletable !== false, auto: false })),
  ];

  const payload = {
    is_external: external,
    marriage_type: _M.type,
    civil_marriage_date: (_M.type === 'convalidation' || _M.type === 'sanatio') ? (_v('mf-civil-date') || null) : null,
    sanatio_faculty: _M.type === 'sanatio' ? (_v('mf-faculty') || null) : null,
    spouse1_first: s1first || null, spouse1_middle: _v('mf-s1-middle') || null, spouse1_last: s1last || null, spouse1_dob: _v('mf-s1-dob') || null,
    spouse1_unbaptized: _M.s1.unbaptized, spouse1_non_catholic: !_M.s1.unbaptized && _M.s1.nonCatholic, spouse1_in_ocia: _M.s1.inOcia, spouse1_ocia_id: _M.s1.ocia?.id || null,
    spouse1_baptism_church: _M.s1.unbaptized ? null : (_v('mf-s1-bchurch') || null), spouse1_baptism_city: _M.s1.unbaptized ? null : (_v('mf-s1-bcity') || null), spouse1_baptism_state: _M.s1.unbaptized ? null : (_v('mf-s1-bstate') || null),
    spouse1_baptism_date: _M.s1.unbaptized ? null : (_v('mf-s1-bdate') || null), spouse1_baptism_by_affidavit: _M.s1.unbaptized ? false : _chk('mf-s1-baffidavit'),
    spouse1_prior_marriages: _M.s1Prior,
    spouse2_first: s2first || null, spouse2_middle: _v('mf-s2-middle') || null, spouse2_last: s2last || null, spouse2_dob: _v('mf-s2-dob') || null,
    spouse2_unbaptized: _M.s2.unbaptized, spouse2_non_catholic: !_M.s2.unbaptized && _M.s2.nonCatholic, spouse2_in_ocia: _M.s2.inOcia, spouse2_ocia_id: _M.s2.ocia?.id || null,
    spouse2_baptism_church: _M.s2.unbaptized ? null : (_v('mf-s2-bchurch') || null), spouse2_baptism_city: _M.s2.unbaptized ? null : (_v('mf-s2-bcity') || null), spouse2_baptism_state: _M.s2.unbaptized ? null : (_v('mf-s2-bstate') || null),
    spouse2_baptism_date: _M.s2.unbaptized ? null : (_v('mf-s2-bdate') || null), spouse2_baptism_by_affidavit: _M.s2.unbaptized ? false : _chk('mf-s2-baffidavit'),
    spouse2_prior_marriages: _M.s2Prior,
    // contact fields (legacy columns)
    groom_phone: normalizePhone(_v('mf-s1-cell')) || null, groom_email: _v('mf-s1-email') || null,
    bride_phone: normalizePhone(_v('mf-s2-cell')) || null, bride_email: _v('mf-s2-email') || null,
    // wedding details (kept for external)
    wedding_date: _v('mf-wd') || null,
    wedding_time: _M.nonChurch ? null : (_v('mf-wt') || null),
    non_church_wedding: _M.nonChurch,
    wedding_institution_id: (instSel && instSel !== '__other') ? instSel : null,
    // "Other location" is the ONLY case the file stores its own address; an
    // institution-based location derives its address from the institution record
    // (read-only), so we do NOT write a per-file city/state copy for it.
    wedding_church_override: instSel === '__other' ? (_v('mf-church-override') || null) : null,
    wedding_city:  instSel === '__other' ? (_v('mf-wcity') || null) : null,
    wedding_state: instSel === '__other' ? (_v('mf-wstate') || null) : null,
    // Officiant + preparer via the shared clergy helpers (name strings).
    officiant: readOfficiantValue('mf-officiant'),
    delegation_given: officiantIsOther('mf-officiant') ? _chk('mf-delegation') : false,
    // Completion chain: Wedding Complete only when status is Complete; records-
    // placement only when Wedding Complete. Reset downstream flags otherwise so they
    // can't linger when a file moves back up the chain.
    wedding_complete: (document.getElementById('mf-status')?.value === 'complete') ? _chk('mf-wedding-complete') : false,
    records_placed: (document.getElementById('mf-status')?.value === 'complete' && _chk('mf-wedding-complete')) ? _chk('mf-records-placed') : false,
    preparer: readPreparerValue('mf-preparer'),
    documents: finalDocs,
    steps: external ? [] : _M.steps,
    fees: _M.fees,
    // keep legacy name fields in sync for fallback + search
    groom: `${s1first} ${s1last}`.trim() || (prior?.groom || null),
    bride: `${s2first} ${s2last}`.trim() || (prior?.bride || null),
    updated_at: nowIso(),
  };
  return { ok: !!(payload.groom || payload.bride), payload, external, prior };
}

// Shared edit writer (status/archive) used by the modal + the shell.
async function _marWriteEdit(id) {
  const r = _marReadPayload();
  if (!r.ok) { alert('At least one spouse name is required.'); return { ok: false }; }
  const { payload, prior } = r;
  // status_code holds ONLY a real status; External is the independent is_external
  // boolean (already in payload). A file can be is_external=true AND complete.
  let st = document.getElementById('mf-status')?.value || prior?.status_code || 'inprogress';
  if (st === 'external') st = 'inprogress';
  payload.status_code = st;
  payload.archived = _chk('mf-archive');
  const _ep = readEditParish('mar-parish-edit'); if (_ep) payload.parish_id = _ep;   // parish reassignment (edit field shown)
  const priorStatus = prior?.status_code ?? null;
  const { error } = await withWriteRetry(() => sb.from('couples').update(payload).eq('id', id), { kind: 'update' });
  if (error) { reportWriteError('couples update', error); return { ok: false }; }
  logActivity({ action: 'updated marriage prep record', entityType: 'marriage', entityName: `${payload.groom} & ${payload.bride}`, contextType: 'couple', contextId: id });
  // Notify on TRANSITION into Complete (separate event from the derived "Finalized").
  // Marriage is cross-linkable → fan out to linked panels' recipients.
  if (priorStatus !== 'complete' && st === 'complete') {
    const { data: { user } } = await sb.auth.getUser();
    notifySacramentEvent({
      keys: ['marriage'], parishId: prior?.parish_id ?? null, originType: 'marriage', originId: id, actorUserId: user?.id,
      message: `${s1Name(prior)} & ${s2Name(prior)} Marriage — marked complete`, type: 'success', module: 'marriage', record_id: id,
    });
  }
  await loadCouplesData();
  return { ok: true };
}

// Create modal save.
async function marSaveCouple() {
  const r = _marReadPayload();
  if (!r.ok) { alert('At least one spouse name is required.'); return; }
  if (_M.isEdit) { const res = await _marWriteEdit(_M.id); if (res.ok) { window.flashSavedThen(() => { marCloseModal(); refreshActivePanel(); }); } return; }
  const { payload } = r;
  let st = document.getElementById('mf-status')?.value || 'inprogress';
  if (st === 'external') st = 'inprogress';
  payload.status_code = st;
  payload.archived = false;
  payload.parish_id = resolveCreateParish(['marriage'], 'marriage', 'mar-parish-select');   // field value / active tab / single parish
  if (!payload.parish_id) { alert('Please select a parish for this record.'); return; }   // safety floor (lockout already prevents this)
  const { error } = await insertWithRetry('couples', payload);
  if (error) { reportWriteError('couples insert', error); return; }
  logActivity({ action: 'created marriage prep record', entityType: 'marriage', entityName: `${payload.groom} & ${payload.bride}`, contextType: 'couple' });
  window.flashSavedThen(async () => { marCloseModal(); await loadCouplesData(); refreshActivePanel(); });
}

// ── Shell config hooks (inline edit form + save/delete/bulk) ─────────────────
export function buildMarEditForm(c) {
  _M = newModalState(c, marTypeReal(c));
  const html = buildCoupleModalHtml(c, { inline: true });
  setTimeout(() => _hydrateModal(), 0);
  return html;
}
export async function marSaveEdit(id) { return _marWriteEdit(id); }
export async function marDeleteRec(id) {
  if (!confirm('Permanently delete this file? This cannot be undone.')) return { ok: false };
  // Capture the display name BEFORE deletion — the record is gone afterward.
  const _c = allCouples.find(x => x.id === id);
  const _name = _c ? `${_c.groom || '?'} & ${_c.bride || '?'}` : 'marriage prep record';
  const { error } = await deleteWithRetry(() => sb.from('couples').delete().eq('id', id));
  if (error) { reportWriteError('couples delete', error); return { ok: false }; }
  allCouples = allCouples.filter(x => x.id !== id);
  logActivity({ action: 'deleted marriage prep record', entityType: 'marriage', entityName: _name, contextType: 'couple' });
  updateCoupleStats();
  return { ok: true };
}
export async function marBulkStatus(ids, status) {
  for (const id of ids) {
    const { error } = await sb.from('couples').update({ status_code: status, updated_at: nowIso() }).eq('id', id);
    if (error) { reportWriteError('couples bulk', error); return { ok: false }; }
    const c = allCouples.find(x => x.id === id); if (c) c.status_code = status;
  }
  logActivity({ action: 'bulk-updated marriage status', entityType: 'marriage', entityName: `${ids.length} files`, contextType: 'couple' });
  updateCoupleStats();
  return { ok: true };
}

async function marDeleteCouple(id) {
  if (!confirm('Permanently delete this file? This cannot be undone.')) return;
  const { error } = await deleteWithRetry(() => sb.from('couples').delete().eq('id', id));
  if (error) { alert('Delete failed: ' + error.message); return; }
  marCloseModal(); await loadCouplesData(); refreshActivePanel();
}

// ── Template settings ────────────────────────────────────────────────────────
let _tplState = null, _tplActive = 'nuptial_mass';
const TPL_TABS = [['nuptial_mass', 'Nuptial Mass'], ['outside_mass', 'Outside Mass'], ['convalidation', 'Convalidation'], ['sanatio', 'Sanatio'], ['external', 'External']];
function openMarriageTemplates() {
  _tplState = JSON.parse(JSON.stringify(_templates));
  _tplActive = 'nuptial_mass';
  _marOpen(buildTplHtml());
  renderTplBody();
}
function buildTplHtml() {
  const tabs = TPL_TABS.map(([v, l]) => `<button class="anl-tpl-tab${_tplActive === v ? ' active' : ''}" onclick="marTplTab('${v}')">${l}</button>`).join('');
  return `<div class="modal-title">Marriage Templates</div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:1rem;border-bottom:.5px solid var(--stone);padding-bottom:8px;">${tabs}</div>
    <div id="mar-tpl-body"></div>
    <div style="font-size:12px;color:#6B7280;font-style:italic;margin-top:1rem;">Changes apply to new files only.</div>
    <div class="modal-actions"><button class="btn-secondary" onclick="marCloseModal()">Cancel</button><button class="btn-primary" onclick="marTplSave()">Save Template</button></div>`;
}
function renderTplBody() {
  const el = document.getElementById('mar-tpl-body'); if (!el) return;
  const t = _tplState[_tplActive] || { documents: [], steps: [], fees_enabled: true, fees: [] };
  // Read-only reference list of auto-added required documents (none for external prep).
  const autoDocsHtml = _tplActive === 'external' ? '' : MARRIAGE_AUTO_DOCS.map(name => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;"><span style="flex:1;font-size:13px;color:#6B7280;">${_esc(name)}</span><i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required (auto-added)"></i></div>`).join('');
  el.innerHTML = `
    ${_sectionHead('Documents')}
    <div style="font-size:12px;color:#6B7280;margin-bottom:8px;">🔒 Locked documents are required and cannot be removed.</div>
    ${autoDocsHtml}
    <div id="mar-tpl-docs">${(t.documents || []).map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;"><span style="flex:1;font-size:13px;">${_esc(d.name)}</span>${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;"></i>` : `<button onclick="marTplRemoveDoc(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;">×</button>`}</div>`).join('') || '<div style="font-size:12px;color:#9CA3AF;font-style:italic;">None.</div>'}</div>
    <div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="mar-tpl-doc-new" placeholder="Add document…" style="flex:1;border-radius:6px;border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;background:#fff;" /><button class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;" onclick="marTplAddDoc()">+ Add</button></div>
    ${_sectionHead('Steps')}
    <div id="mar-tpl-steps">${(t.steps || []).map((s, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;"><span style="flex:1;font-size:13px;">${_esc(s.step)}</span><button onclick="marTplRemoveStep(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;">×</button></div>`).join('') || '<div style="font-size:12px;color:#9CA3AF;font-style:italic;">None.</div>'}</div>
    <div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="mar-tpl-step-new" placeholder="Add step…" style="flex:1;border-radius:6px;border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;background:#fff;" /><button class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;" onclick="marTplAddStep()">+ Add</button></div>
    ${_sectionHead('Fees')}
    ${_toggle('mar-tpl-fees-enabled', 'Fees enabled', t.fees_enabled !== false, 'marTplFeesEnabled()')}
    <div id="mar-tpl-fees" style="margin-top:6px;">${(t.fees || []).map((f, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;"><span style="flex:1;font-size:13px;">${_esc(f.name)}</span><span style="font-size:12px;color:#5B4636;">$${Number(f.amount) || 0}</span><button onclick="marTplRemoveFee(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;">×</button></div>`).join('') || '<div style="font-size:12px;color:#9CA3AF;font-style:italic;">None.</div>'}</div>
    <div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="mar-tpl-fee-name" placeholder="Fee name…" style="flex:2;border-radius:6px;border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;background:#fff;" /><input type="number" id="mar-tpl-fee-amt" placeholder="$" style="flex:1;border-radius:6px;border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;background:#fff;" /><button class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;" onclick="marTplAddFee()">+ Add</button></div>`;
}
function marTplTab(v) { _tplActive = v; document.querySelectorAll('.anl-tpl-tab').forEach(b => b.classList.remove('active')); event.target.classList.add('active'); renderTplBody(); }
function _tpl() { _tplState[_tplActive] = _tplState[_tplActive] || { documents: [], steps: [], fees_enabled: true, fees: [] }; return _tplState[_tplActive]; }
function marTplAddDoc() { const i = document.getElementById('mar-tpl-doc-new'); const n = (i?.value || '').trim(); if (!n) return; _tpl().documents.push({ name: n, deletable: true }); renderTplBody(); }
function marTplRemoveDoc(i) { _tpl().documents.splice(i, 1); renderTplBody(); }
function marTplAddStep() { const i = document.getElementById('mar-tpl-step-new'); const n = (i?.value || '').trim(); if (!n) return; _tpl().steps.push({ step: n, completed: false }); renderTplBody(); }
function marTplRemoveStep(i) { _tpl().steps.splice(i, 1); renderTplBody(); }
function marTplFeesEnabled() { _tpl().fees_enabled = document.getElementById('mar-tpl-fees-enabled').checked; }
function marTplAddFee() { const nm = document.getElementById('mar-tpl-fee-name'); const am = document.getElementById('mar-tpl-fee-amt'); const n = (nm?.value || '').trim(); if (!n) return; _tpl().fees.push({ name: n, amount: Number(am?.value) || 0, paid: false }); renderTplBody(); }
function marTplRemoveFee(i) { _tpl().fees.splice(i, 1); renderTplBody(); }
async function marTplSave() {
  const t = _tpl();
  const { error } = await sb.from('marriage_templates').upsert({ marriage_type: _tplActive, documents: t.documents, steps: t.steps, fees_enabled: t.fees_enabled !== false, fees: t.fees, updated_at: nowIso() }, { onConflict: 'marriage_type' });
  if (error) { alert('Save failed: ' + error.message); return; }
  _templates[_tplActive] = JSON.parse(JSON.stringify(t));
  window.flashSaved();   // shared green "Saved ✓" confirmation
}

Object.assign(window, {
  openCoupleAdd, openCoupleEdit,
  toggleCoupleDoc, toggleCoupleStep, toggleCoupleFee, toggleCoupleDelegation, toggleCoupleWeddingComplete, toggleCoupleRecordsPlaced, addCoupleNoteLog, coupleEditNoteLog,
  marCloseModal, marSaveCouple, marDeleteCouple, marValidateParish,
  marOnExternalToggle, marOnTypeChange, marOnNonChurchToggle, marOnInstitutionChange, marOnOfficiantOtherToggle, marOnStatusChange, marOnWeddingCompleteToggle,
  marSpouseToggle, marPriorToggle, marAddPrior, marRemovePrior, marPriorEndedChange,
  marOciaSearch, marRemoveOcia, marAnnulSearch, marRemoveAnnul,
  marDocReceived, marRemoveDoc, marAddDoc, marAddStep, marRemoveStep, marStepDragStart, marStepDrop, marAddFee, marRemoveFee, marFeePaid,
  openMarriageTemplates, marTplTab, marTplAddDoc, marTplRemoveDoc, marTplAddStep, marTplRemoveStep, marTplFeesEnabled, marTplAddFee, marTplRemoveFee, marTplSave,
  expandCase, expandCouple,
});
