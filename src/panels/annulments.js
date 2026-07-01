import { sb, withWriteRetry, serializeWrite, insertWithRetry, deleteWithRetry } from '../supabase.js';
import { notifyUsers, notifySacramentEvent } from '../notifications.js';
import { store } from '../store.js';
import { fmtDate, todayCST, logActivity, reportWriteError, applyDocCheck, docCheckStampHtml } from '../utils.js';
import { isAdmin, canAccessSacrament, isSacramentCoordinator } from '../roles.js';
import { hasMyGrantForLink } from '../ui/grants.js';
import { normalizePhone } from '../utils/phone.js';
import { renderSacramentalPanel, refreshActivePanel, openSacramentalRecord } from '../sacramental/panelShell.js';
import { promptNoteEdit } from '../sacramental/noteEdit.js';
import { sealGuardConfirm } from '../ui/sealGuard.js';
// Cross-panel display resolvers (DB-backed, by id) so an annulment's linked
// Marriage/OCIA labels render even if those panels were never opened. Function
// imports only (called at runtime) — the panel↔panel cycle is safe.
import { ensureOciaDisplays, getOciaDisplay } from './ocia.js';
import { ensureCoupleDisplays, getCoupleDisplay } from './marriage.js';

// ── Status (legacy codes preserved for backward compatibility) ───────────────
export const CASE_STATUS = {
  prep:     { label: 'Preparing',             color: '#1B4F72', bg: '#D6EAF8', dot: '#1B4F72' },
  tribunal: { label: 'In Tribunal',           color: '#7D6608', bg: '#FEF9E7', dot: '#D4AC0D' },
  affirm:   { label: 'Affirmative Judgement', color: '#2D6A4F', bg: '#D8F3DC', dot: '#2D6A4F' },
  negative: { label: 'Negative Judgement',    color: '#922B21', bg: '#FDEDEC', dot: '#E74C3C' },
  archived: { label: 'Inactive',              color: '#616A6B', bg: '#F2F3F4', dot: '#AAB7B8' },
};
const STATUS_ORDER = ['prep', 'tribunal', 'affirm', 'negative', 'archived'];

// ── Annulment types ──────────────────────────────────────────────────────────
const ANNULMENT_TYPES = [
  { v: 'formal',       label: 'Formal Case',                badge: 'Formal' },
  { v: 'lack_of_form', label: 'Lack of Form',               badge: 'Lack of Form' },
  { v: 'petrine',      label: 'Petrine Privilege',          badge: 'Petrine' },
  { v: 'pauline',      label: 'Pauline Privilege',          badge: 'Pauline' },
  { v: 'ligamen',      label: 'Ligamen',                    badge: 'Ligamen' },
  { v: 'ratum',        label: 'Ratum et non Consummatum',   badge: 'Ratum' },
];
export const TYPE_BADGE = Object.fromEntries(ANNULMENT_TYPES.map(t => [t.v, t.badge]));

// Static reference content for the "Requirements for Annulment Types" help window
// (the "?" next to the type selector). Order MATCHES the type dropdown. Display-only;
// not stored in the DB.
const ANNULMENT_TYPE_HELP = [
  { title: 'Formal Case', paras: [
    'A formal case is the term used for an annulment petition based on grounds that fall into the following categories:',
    '1. Catholic married to a Catholic: When a Catholic who was previously married to another Catholic in the Church seeks a declaration of nullity for their marriage.',
    '2. Baptized non-Catholic married to a baptized non-Catholic: When a validly baptized non-Catholic who was married to another validly baptized non-Catholic in a non-Catholic church or before a justice of the peace petitions for the nullity of the marriage.',
    '3. Catholic married to a non-Catholic: When a Catholic who married a non-Catholic, baptized or unbaptized, in a Catholic Church or in a non-Catholic religious ceremony with proper permission from the bishop of the Catholic party petitions for an annulment.',
    '4. Other cases: Any marriage annulment case that does not meet the requirements for it to be processed as a lack of form, prior bond, Pauline Privilege, or Petrine Privilege case.',
  ] },
  { title: 'Lack of Form', paras: [
    'Lack of canonical form, or, for short, "lack of form," occurs when a Catholic contracts a marriage before a justice of the peace, a civil magistrate, or a non-Catholic religious minister without a dispensation or authorization from the bishop. Thus, only those Catholic marriages contracted before a properly delegated Catholic bishop, priest, or deacon and in the presence of two witnesses are valid.',
  ] },
  { title: 'Petrine Privilege', paras: [
    'Petrine Privilege occurs when a man and a woman, at least one of whom was unbaptized prior to the marriage, contract marriage, and at least one of the parties remains unbaptized subsequent to the marriage. After the breakup of the marriage, one of the parties wishes to marry another person in the Church. In such a case, the Church may grant the Petrine Privilege, provided that the party who wishes to marry in the Church was not the principal cause of the breakup of the previous marriage, and provided that the person he or she wishes to marry is free to marry in the Catholic Church.',
  ] },
  { title: 'Pauline Privilege', paras: [
    'Pauline Privilege occurs when an unbaptized man and an unbaptized woman enter into marriage and, subsequent to the marriage, one of them becomes validly baptized or wishes to be baptized in the Catholic Church. After the couple has divorced, the convert or converting party wishes to marry another person in the Church. In such a case, the Pauline Privilege may be granted, provided that the convert or converting party was not the principal cause of the breakup of his or her marriage with the unbaptized party.',
  ] },
  { title: 'Ligamen (Prior Bond)', paras: [
    'A person who has been previously married cannot enter into a valid marriage in the Catholic Church, unless the prior marriage has been declared null by the Catholic Church. This law applies to both Catholics and non-Catholics, baptized and unbaptized. Even if the prior marriage is believed invalid or dissolved for any reason, it is not, on that account, permitted to contract another before the nullity or dissolution of the prior marriage has been established legitimately and certainly by the Tribunal. (c. 1085, §§1-2).',
    'Prior bond is always on the part of the other party or respondent. If the petitioner was the one who previously married, an investigation of the first marriage must first be conducted. If it is found to be null, the validity of the second marriage is presumed. If, after investigation, the second marriage is proven null, the validity of the third marriage is presumed. Therefore, the Tribunal does not declare the marriages of a petitioner subsequent to the first null by reason of prior bond and then proceeds to declare the first marriage null by a formal trial.',
    'Thus, prior bond is always on the part of the respondent. It is when a petitioner married a respondent whose prior marriage was not annulled or dissolved by the Catholic Church, either before or after the marriage of the petitioner and the respondent.',
    'In such a case, the marriage of the petitioner and the respondent may be considered invalid on the ground of prior bond—namely, that the petitioner married a respondent who was bound by a previous marriage that had neither been annulled nor dissolved by the Catholic Church, either before or after their marriage.',
  ] },
  { title: 'Ratum et Non Consummatum', paras: [
    'In canon law, a ratum et non consummatum (ratified and not consummated) marriage refers to a valid union between two baptized persons who have exchanged legal consent but have not yet engaged in sexual intercourse. While the Catholic Church views a validly contracted and consummated sacramental marriage as absolutely indissoluble by any human power, an unconsummated union holds a distinct juridical status. Under Canon 1141, a ratum et non consummatum marriage can be dissolved by the Pope for a just reason through an administrative dispensation rather than a standard judicial annulment.',
  ] },
];

const COUNTRIES = ['United States of America', 'Mexico', 'Philippines', 'Vietnam', 'Nigeria', 'India', 'Other'];
const PROGRESS_OPTIONS = ['Submitted to Tribunal', 'Received by Tribunal', 'Witnesses Cited', 'Acts Published', 'Other'];
// Preseeded procedural events offered in the timeline dropdown. The five
// auto-generated milestones (Case Opened / Submitted to Tribunal / Affirmative
// Judgement / Negative Judgement / Case Closed) are added by the system on the
// matching status transition and are NOT in this list — the dropdown shows these
// procedural steps plus a "+ Other…" free-text option.
export const TIMELINE_EVENTS = ['Received by Tribunal', 'Witnesses Cited', 'Acts Published', 'Sent to Defender of the Bond'];

// Type-conditional form sections. The petitioner-baptism + respondent
// baptism/Catholic-status blocks are surfaced for the privilege and ratum cases
// (where prior bond / baptismal status is at issue) and for Formal cases. They are
// trimmed for Lack of Form, where the defect of canonical form — not baptismal
// detail — is decisive. Marriage info, previous annulments, tribunal and document
// sections stay visible for every type. Adjustable in one place if canon dictates.
const TYPE_SECTIONS = {
  formal:       { baptism: true },
  lack_of_form: { baptism: false },
  petrine:      { baptism: true },
  pauline:      { baptism: true },
  ligamen:      { baptism: true },
  ratum:        { baptism: true },
};
function typeSections(type) { return TYPE_SECTIONS[type] || TYPE_SECTIONS.formal; }
import { stateSelect } from '../ui/stateSelect.js';

// ── Baptismal status (Petitioner + Respondent share this identical set) ───────
// Six booleans per party. `n` is the 1-6 index used by the symmetric exclusion sets;
// `suffix` maps to the DB column `{pet|resp}_bap_{suffix}`. The exclusion sets are
// SYMMETRIC (checking either member of an excluded pair disables the other, both
// directions, order-independent): 1 (Catholic) and 6 (Non-Religious) each stand
// alone; the rest allow the combos 2+3, 2+4, 3+4, 2+3+4, 4+5.
const BAP_STATUS = [
  { n: 1, suffix: 'catholic',        label: 'Baptized Catholic' },
  { n: 2, suffix: 'noncatholic',     label: 'Baptized in a non-Catholic Christian Community' },
  { n: 3, suffix: 'became_catholic', label: 'Became Catholic after Baptism' },
  { n: 4, suffix: 'ocia',            label: 'Enrolled in OCIA' },
  { n: 5, suffix: 'never',           label: 'Never Been Baptized' },
  { n: 6, suffix: 'nonreligious',    label: 'Non-Religious Person' },
];
const BAP_EXCL = { 1: [2,3,4,5,6], 2: [1,5,6], 3: [1,5,6], 4: [1,6], 5: [1,2,3,6], 6: [1,2,3,4,5] };
// Baptism-location column map per party (id prefix → DB columns). 'pet'/'resp' match
// the am-pet-/am-resp- form-id prefixes AND the pet_bap_/resp_bap_ status prefixes.
const BAP_LOC_COLS = {
  pet:  { church: 'petitioner_baptism_church', city: 'petitioner_baptism_city', state: 'petitioner_baptism_state', country: 'petitioner_baptism_country', affidavit: 'petitioner_baptism_by_affidavit' },
  resp: { church: 'respondent_baptism_church', city: 'respondent_baptism_city', state: 'respondent_baptism_state', country: 'respondent_baptism_country', affidavit: 'respondent_baptism_by_affidavit' },
};
const RESP_BAPTISM_DOC = 'Respondent Baptismal Certificate or Affidavit';
const _bapChecked = (prefix, n) => !!document.getElementById(`am-${prefix}-bap${n}`)?.checked;
// A party is "unbaptized" (no baptism doc/fields apply) when (5) Never OR (6) Non-Religious.
const _partyNoBaptism = (prefix) => _bapChecked(prefix, 5) || _bapChecked(prefix, 6);


// Hardcoded fallback templates (used only if the annulment_templates table can't be read)
const FALLBACK_TEMPLATES = {
  formal:       [{ name: 'Completed Petition', deletable: false }, { name: 'Personal Testimony', deletable: true }, { name: 'Petitioner Baptismal Certificate or Affidavit', deletable: true }, { name: 'Marriage License', deletable: false }, { name: 'Divorce Decree', deletable: false }],
  lack_of_form: [{ name: 'Completed Petition', deletable: false }, { name: 'Petitioner Baptismal Certificate or Affidavit', deletable: true }, { name: 'Marriage License', deletable: false }, { name: 'Divorce Decree', deletable: false }],
  petrine:      [{ name: 'Completed Petition', deletable: false }, { name: 'Personal Testimony', deletable: true }, { name: 'Petitioner Baptismal Certificate or Affidavit', deletable: true }, { name: 'Marriage License', deletable: false }, { name: 'Divorce Decree', deletable: false }],
  pauline:      [{ name: 'Completed Petition', deletable: false }, { name: 'Personal Testimony', deletable: true }, { name: 'Petitioner Baptismal Certificate or Affidavit', deletable: true }, { name: 'Marriage License', deletable: false }, { name: 'Divorce Decree', deletable: false }],
  ligamen:      [{ name: 'Completed Petition', deletable: false }, { name: 'Personal Testimony', deletable: true }, { name: 'Petitioner Baptismal Certificate or Affidavit', deletable: true }, { name: 'Marriage License', deletable: false }, { name: 'Divorce Decree', deletable: false }],
  ratum:        [{ name: 'Completed Petition', deletable: false }, { name: 'Personal Testimony', deletable: true }, { name: 'Petitioner Baptismal Certificate or Affidavit', deletable: true }, { name: 'Marriage Certificate', deletable: false }, { name: 'Proof of Non-Consummation', deletable: true }],
};

let allCases = [];
let _templates = {};   // annulment_type → [{name, deletable}]
let _M = null;         // working state for the open create/edit modal
let _anlCoordinatorIds = [];   // annulment coordinator personnel ids (Advocate option source)

// ── Access helpers ───────────────────────────────────────────────────────────
function fullAccess()  { return isAdmin() || canAccessSacrament('annulments'); }
function advocateIds()  { return store.currentUserRoles?.advocateCaseIds || []; }
function advocateOnly() { return !fullAccess() && advocateIds().length > 0; }
// View gate (universal % grant scoping). Annulments is cura/group-wide, so coordinators
// (fullAccess) see every case; an ADVOCATE sees only cases they're assigned to; anyone
// with a record_grant sees the granted case. This scopes an advocate — who reaches the
// panel via advocateCaseIds — to their own cases instead of the whole caseload.
function canView(c) {
  return fullAccess() || advocateIds().includes(c.id) || hasMyGrantForLink('annulment', c.id);
}

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _curUserId()   { return store.currentUserProfile?.user_id || null; }
function _curUserName() { return store.currentUserProfile?.personnel?.name || 'Staff'; }

// ── Field accessors with backward-compatible fallback ────────────────────────
function caseType(c) {
  if (c.annulment_type) return c.annulment_type;
  const t = (c.type || '').toLowerCase();
  if (t.includes('lack of form')) return 'lack_of_form';
  if (t.includes('petrine'))      return 'petrine';
  if (t.includes('pauline'))      return 'pauline';
  if (t.includes('ligamen'))      return 'ligamen';
  if (t.includes('ratum'))        return 'ratum';
  return 'formal';
}
function petName(c) {
  if (c.petitioner_first || c.petitioner_last) {
    const maiden = c.petitioner_maiden ? ` (${c.petitioner_maiden})` : '';
    return `${c.petitioner_first || ''} ${c.petitioner_last || ''}`.trim() + maiden;
  }
  return c.petitioner || '(Unnamed)';
}
function respName(c) {
  if (c.respondent_first || c.respondent_last) {
    const maiden = c.respondent_maiden ? ` (${c.respondent_maiden})` : '';
    return `${c.respondent_first || ''} ${c.respondent_last || ''}`.trim() + maiden;
  }
  return c.respondent || c.co_petitioner || '';
}
// Card-label last names — maiden replaces last name where applicable.
function petLast(c) { return c.petitioner_maiden || c.petitioner_last || String(c.petitioner || '').trim().split(/\s+/).pop() || ''; }
function respLast(c) { return c.respondent_maiden || c.respondent_last || String(c.respondent || c.co_petitioner || '').trim().split(/\s+/).pop() || ''; }
function advocateName(c) {
  if (c.advocate_id) { const p = (store.personnel || []).find(x => x.id === c.advocate_id); if (p) return p.name; }
  return c.advocate_name_override || '';
}
function caseDocs(c) {
  return (c.documents || []).map(d => ({
    name: d.name, received: d.received ?? d.done ?? false, deletable: d.deletable ?? true, checked_on: d.checked_on || null,
  }));
}
function caseTimeline(c) {
  const out = (c.timeline || []).map(e => (e.text !== undefined || e.type !== undefined)
    ? { type: e.type || 'note', text: e.text || e.event || '', created_at: e.created_at || e.date || null, by: e.by || null }
    : { type: 'note', text: e.event || '', created_at: e.date || null, by: null });
  // Legacy single notes field → one trailing note entry (display only)
  if (c.notes && c.notes.trim()) out.push({ type: 'note', text: c.notes.trim(), created_at: null, by: null, _legacy: true });
  return out;
}

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadTemplates() {
  const { data, error } = await sb.from('annulment_templates').select('annulment_type, documents');
  _templates = {};
  if (!error && data) data.forEach(r => { _templates[r.annulment_type] = r.documents || []; });
  ANNULMENT_TYPES.forEach(t => { if (!_templates[t.v]) _templates[t.v] = FALLBACK_TEMPLATES[t.v].slice(); });
}

// Advocate option source — the annulment program's coordinator personnel ids. The
// Advocate dropdown merges these with parish clergy + Other (same people as the
// shared Clergy+Coordinator+Other helper), but stores the FK id rather than a name.
async function loadAnnulmentCoordinator() {
  try {
    const { data } = await sb.from('program_coordinators').select('coordinator_ids').eq('program', 'annulments').is('parish_id', null).maybeSingle();   // cura → NULL-parish row
    _anlCoordinatorIds = data?.coordinator_ids || [];
  } catch (_) { _anlCoordinatorIds = []; }
}

// Data-only fetch (no render) — used by the shell's fetchRecords + autosave refresh.
export async function loadCasesData() {
  await Promise.all([loadTemplates(), loadAnnulmentCoordinator()]);
  const { data, error } = await sb.from('annulment_cases').select('*');
  if (error) { console.error('[annulments]', error); return []; }
  let rows = data || [];
  if (advocateOnly()) { const ids = advocateIds(); rows = rows.filter(c => ids.includes(c.id)); }
  rows.sort((a, b) => petLast(a).toLowerCase().localeCompare(petLast(b).toLowerCase()));
  allCases = rows;
  store.allCases = allCases;
  // Warm the cross-panel display caches for every legacy linked Marriage/OCIA record
  // so their labels resolve by id without the Marriage/OCIA panels being loaded.
  await ensureCoupleDisplays(allCases.map(c => c.linked_marriage_prep_id));
  await ensureOciaDisplays(allCases.map(c => c.linked_ocia_id));
  renderAnnulmentAlerts();
  updateAnnulmentStats();
  return allCases;
}

// Nav loader — fetch, then mount the master-detail shell (with the confidentiality
// notice preserved above it) into #annulments-root.
export async function loadCases() {
  await loadCasesData();
  const root = document.getElementById('annulments-root');
  if (!root) return;
  const advNote = advocateOnly()
    ? `<div style="margin-top:6px;font-size:12px;color:#6B7280;">You are viewing cases where you are assigned as advocate.</div>` : '';
  root.innerHTML = `
    <div class="confid-notice">
      <i class="fa-solid fa-lock" style="margin-right:7px;"></i>Annulment records are strictly confidential. Access is limited to assigned advocates and authorized personnel only.${advNote}
    </div>
    <div class="stat-row">
      <div class="stat-card"><div class="stat-num" id="stat-anl-prep">—</div><div class="stat-label">Preparing</div></div>
      <div class="stat-card"><div class="stat-num" id="stat-anl-tribunal">—</div><div class="stat-label">In Tribunal</div></div>
      <div class="stat-card"><div class="stat-num" id="stat-anl-notfinal">—</div><div class="stat-label">Not Finalized</div></div>
    </div>
    <div id="annulments-alerts"></div>
    <div id="annulments-shell"></div>`;
  renderAnnulmentAlerts();
  updateAnnulmentStats();
  const { annulmentConfig } = await import('../sacramental/annulmentConfig.js');
  renderSacramentalPanel(document.getElementById('annulments-shell'), annulmentConfig);
}

// Top-of-panel statistics, matching the other sacramental panels' stat-row. Counts
// exclude archived cases (the `archived` boolean) to match every other panel's
// convention (active = !archived). Elements only exist once loadCases() has rendered
// the panel, so each set() is guarded for the data-only refresh path.
function updateAnnulmentStats() {
  const active = allCases.filter(c => !c.archived);
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('stat-anl-prep', active.filter(c => (c.status_code || 'prep') === 'prep').length);
  set('stat-anl-tribunal', active.filter(c => c.status_code === 'tribunal').length);
  set('stat-anl-notfinal', active.filter(c => ['affirm', 'negative'].includes(c.status_code) && c.judgement_finalized === 'no').length);
}

// ── Cross-panel case display cache ──────────────────────────────────────────
// Marriage/OCIA prior-marriage rows reference annulment cases by id. Their chips
// (label) and "resolved" flag must render even if the Annulments panel was never
// opened this session — so we resolve those cases by id DIRECTLY from the DB into
// a small cache, instead of reading the panel's lazy-loaded `allCases` list.
// Only the few display columns are fetched, and already-known cases are reused.
const _caseDisplayCache = new Map();   // id -> { petitioner, respondent, status_code, judgement_finalized }
// Resolve the given case ids, fetching any not already cached or in memory.
export async function ensureCaseDisplays(ids) {
  const want = [...new Set((ids || []).filter(Boolean))];
  if (!want.length) return;
  // Reuse the panel's loaded list when present (no fetch needed for those).
  for (const c of allCases) if (c?.id) _caseDisplayCache.set(c.id, c);
  const miss = want.filter(id => !_caseDisplayCache.has(id));
  if (!miss.length) return;
  const { data } = await sb.from('annulment_cases')
    .select('id, petitioner, respondent, status_code, judgement_finalized').in('id', miss);
  (data || []).forEach(r => _caseDisplayCache.set(r.id, r));
}
// Sync read: cache first, then the panel's in-memory list (either source works).
export function getCaseDisplay(id) {
  return _caseDisplayCache.get(id) || allCases.find(x => x.id === id) || (store.allCases || []).find(x => x.id === id) || null;
}

// ── Shell accessors (consumed by annulmentConfig) ───────────────────────────
export function getCaseRecords() { return allCases; }
export function getCaseRecord(id) { return allCases.find(x => x.id === id) || null; }
export { fullAccess as anlCanManage, canView as anlCanView };   // CASE_STATUS / TYPE_BADGE already exported above
export { caseType, petName, respName, petLast, respLast, advocateName, caseDocs, caseTimeline, BAP_STATUS };

// ── Priority Actions banner ──────────────────────────────────────────────────
// Missing documents for PREPARING cases only. Every non-Preparing status (In
// Tribunal / Judgement / Inactive) and every archived case is excluded — only
// active prep work surfaces here. Steps are not a concept for annulments; this is
// documents-only. One line per case: "PetLast vs RespLast: doc, doc, …" (maiden
// overrides last, matching the card title).
function _caseTitle(c) { return `${petLast(c) || '—'} vs ${respLast(c) || '—'}`; }
// Data-based "unbaptized" check (5 Never / 6 Non-Religious) — mirrors the viewer's
// hide logic so a hidden baptism doc never surfaces as a "missing" required document.
const _caseNoBap = (c, party) => party === 'resp'
  ? !!(c.resp_bap_never || c.resp_bap_nonreligious)
  : !!(c.pet_bap_never || c.pet_bap_nonreligious);
export function annulmentAlertItems(c) {
  if (c.archived || (c.status_code || 'prep') !== 'prep') return [];
  const petNoBap = _caseNoBap(c, 'pet'), respNoBap = _caseNoBap(c, 'resp');
  return caseDocs(c).filter(d => {
    if (d.received) return false;
    const isResp = /baptism/i.test(d.name) && /respondent/i.test(d.name);
    const isPet = /baptism/i.test(d.name) && !/respondent/i.test(d.name);
    if (isPet && petNoBap) return false;                  // petitioner unbaptized → doc not required
    if (isResp && (!petNoBap || respNoBap)) return false; // respondent baptism doc hidden
    return true;
  }).map(d => d.name);
}
function renderAnnulmentAlerts() {
  const el = document.getElementById('annulments-alerts'); if (!el) return;
  const blocks = [];
  for (const c of allCases) {
    const missing = annulmentAlertItems(c);
    if (missing.length) blocks.push({ c, missing });
  }
  if (!blocks.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="alert-strip" style="margin-bottom:1rem;flex-direction:column;align-items:flex-start;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><i class="ti ti-alert-triangle" style="color:var(--gold);font-size:15px;"></i><strong style="font-size:13px;">Priority actions</strong></div>
    ${blocks.map(b => `<div style="font-size:13px;color:var(--navy);margin-bottom:4px;">
      <strong>${_esc(_caseTitle(b.c))}</strong>: ${b.missing.map(_esc).join(', ')}
    </div>`).join('')}
  </div>`;
}

// ── Panel chrome ─────────────────────────────────────────────────────────────
// Cross-link entry — open a specific case in the shell (deep-link), called from
// other panels / message links.
export async function expandCase(id) {
  openSacramentalRecord('annulments', id);   // set the hash first so the shell opens it on mount
  window.switchPanel('annulments');
}

// ── Timeline writes ──────────────────────────────────────────────────────────
function nowIso() { return new Date().toISOString(); }
function _rawTimeline(c) { return JSON.parse(JSON.stringify(c.timeline || [])); }

// ── Viewer-editable autosave (documents + timeline) ──────────────────────────
// Serialize per-case so rapid checkbox/timeline edits don't overlap; retry
// transport failures (mirrors the Marriage viewer's _patch path).
async function _anlPatch(caseId, patch) {
  const c = allCases.find(x => x.id === caseId); if (!c) return null;
  const { error } = await serializeWrite(`anlcase:${caseId}`, () =>
    withWriteRetry(() => sb.from('annulment_cases').update({ ...patch, updated_at: nowIso() }).eq('id', caseId), { kind: 'update' }));
  if (error) { reportWriteError('annulment update', error); return null; }
  Object.assign(c, patch);
  return c;
}

// Document checkbox in the read view (write-retry wrapped).
async function toggleCaseDoc(caseId, i) {
  const c = allCases.find(x => x.id === caseId); if (!c) return;
  const docs = caseDocs(c).map(d => ({ name: d.name, received: d.received, deletable: d.deletable, checked_on: d.checked_on || null }));
  if (!docs[i]) return;
  applyDocCheck(docs[i], !docs[i].received);
  if (await _anlPatch(caseId, { documents: docs })) { refreshActivePanel(); renderAnnulmentAlerts(); }
}

// Inline baptism-location edit from the viewer (shown when the party's baptism doc is
// unchecked). party = 'pet' | 'resp'; field = church|city|state|country → the matching
// {party}_baptism_* column (BAP_LOC_COLS). Routes through the write-retry wrapper; NO
// full re-render, so focus/tabbing across the fields is preserved. After each save we
// live-sync that party's baptism checkbox lock in place.
const BAPTISM_LOCK_TIP = 'Enter the church name, city, and state before marking the baptism record received.';
// Per-party location columns used by the viewer lock-gate (church/city/state/country).
const _bapLocColList = (party) => { const m = BAP_LOC_COLS[party]; return [m.church, m.city, m.state, m.country]; };
async function anlSaveBaptismField(caseId, party, field, el) {
  const col = BAP_LOC_COLS[party]?.[field]; if (!col) return;
  await _anlPatch(caseId, { [col]: (el?.value || '').trim() || null });
  _anlSyncBaptismLock(caseId, party);
}
// Inline "By Affidavit" toggle from the viewer. party = 'pet' | 'resp'. Independent of
// the lock-gate. Saves via the write-retry wrapper; no re-render.
async function anlToggleBaptismAffidavit(caseId, party, checked) {
  const col = BAP_LOC_COLS[party]?.affidavit; if (!col) return;
  await _anlPatch(caseId, { [col]: !!checked });
}
// Enable/disable a party's baptism checkbox in place as the location fields are
// filled/cleared, without re-rendering (which would drop input focus mid-edit).
// Forward-only; party = 'pet' | 'resp'.
function _anlSyncBaptismLock(caseId, party) {
  const c = allCases.find(x => x.id === caseId); if (!c) return;
  const box = document.getElementById(`anl-bdoc-box-${party}-${caseId}`); if (!box) return;
  const docs = caseDocs(c);
  const idx = party === 'resp'
    ? docs.findIndex(d => /baptism/i.test(d.name) && /respondent/i.test(d.name))
    : docs.findIndex(d => /baptism/i.test(d.name) && !/respondent/i.test(d.name));
  if (idx < 0) return;
  const filled = _bapLocColList(party).every(k => String(c[k] || '').trim());
  if (filled) {
    box.setAttribute('onclick', `toggleCaseDoc('${caseId}',${idx})`);
    box.style.cursor = 'pointer'; box.style.opacity = '1'; box.removeAttribute('title');
  } else {
    box.removeAttribute('onclick');
    box.style.cursor = 'not-allowed'; box.style.opacity = '0.45'; box.setAttribute('title', BAPTISM_LOCK_TIP);
  }
  const note = document.getElementById(`anl-bdoc-note-${party}-${caseId}`);
  if (note) note.style.display = filled ? 'none' : 'block';
}

// Timeline: show/hide the free-text "Other" input when the dropdown changes.
function anlTlSelChange(caseId) {
  const sel = document.getElementById(`anl-tl-sel-${caseId}`);
  const wrap = document.getElementById(`anl-tl-other-${caseId}`);
  if (sel && wrap) wrap.style.display = sel.value === '__other' ? 'block' : 'none';
}
// Add a MANUAL timeline entry from the dropdown (+ Other free-text) and the
// editable date picker (prefilled today; any earlier date backdates the entry).
async function anlAddTimelineEntry(caseId) {
  const c = allCases.find(x => x.id === caseId); if (!c) return;
  const sel = document.getElementById(`anl-tl-sel-${caseId}`);
  const dateEl = document.getElementById(`anl-tl-date-${caseId}`);
  if (!sel) return;
  let text = sel.value;
  if (text === '__other') text = (document.getElementById(`anl-tl-other-input-${caseId}`)?.value || '').trim();
  if (!text) return;
  const date = (dateEl?.value || '').trim() || todayCST();
  // Backdated entries are stamped at midday of the chosen day; a today entry keeps
  // the full timestamp so same-day entries stay in insertion order.
  const created_at = (date === todayCST()) ? nowIso() : `${date}T12:00:00.000Z`;
  const tl = _rawTimeline(c);
  tl.push({ type: 'progress', text, created_at, created_by: _curUserId() });
  if (await _anlPatch(caseId, { timeline: tl })) window.flashSavedThen(() => refreshActivePanel());
}
// Manual deletion of ANY timeline entry (including auto milestones) — for
// correcting a mistaken flag. Operates on the raw timeline array by index.
async function anlDeleteTimelineEntry(caseId, idx) {
  const c = allCases.find(x => x.id === caseId); if (!c) return;
  const tl = _rawTimeline(c);
  if (idx < 0 || idx >= tl.length) return;
  tl.splice(idx, 1);
  if (await _anlPatch(caseId, { timeline: tl })) refreshActivePanel();
}

// ── Notes (stored as a JSON array in the `notes` TEXT column) ─────────────────
// annulment_cases has no notes_log jsonb (unlike couples), and `notes` is a plain
// text column. We persist the notes LIST as JSON-encoded text and read it back
// here, tolerating a legacy single plain-string note (seeded prose) as one entry.
function _normNote(n) { return { text: n.text || n.note || '', created_at: n.created_at || null, created_by: n.created_by || null, edited_at: n.edited_at || null }; }
export function parseCaseNotes(c) {
  const raw = c?.notes;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(_normNote);
  const s = String(raw).trim();
  if (!s) return [];
  if (s[0] === '[') { try { const arr = JSON.parse(s); if (Array.isArray(arr)) return arr.map(_normNote); } catch (_) { /* fall through to legacy */ } }
  return [{ text: s, created_at: null, created_by: null }];   // legacy single note
}
async function anlAddNote(caseId) {
  const c = allCases.find(x => x.id === caseId); if (!c) return;
  const inp = document.getElementById(`anl-note-input-${caseId}`);
  const text = (inp?.value || '').trim();
  if (!text) return;
  if (!(await sealGuardConfirm(text))) return;   // shared seal-of-confession guard on the note
  const list = parseCaseNotes(c);
  list.push({ text, created_at: nowIso(), created_by: _curUserId() });
  if (await _anlPatch(caseId, { notes: JSON.stringify(list) })) window.flashSavedThen(() => refreshActivePanel());
}
async function anlDeleteNote(caseId, idx) {
  const c = allCases.find(x => x.id === caseId); if (!c) return;
  const list = parseCaseNotes(c);
  if (idx < 0 || idx >= list.length) return;
  list.splice(idx, 1);
  if (await _anlPatch(caseId, { notes: list.length ? JSON.stringify(list) : null })) refreshActivePanel();
}
// Edit a case note in place: overwrite text + stamp edited_at (no history).
async function anlEditNote(caseId, idx) {
  const c = allCases.find(x => x.id === caseId); if (!c) return;
  const list = parseCaseNotes(c);
  if (idx < 0 || idx >= list.length) return;
  const text = promptNoteEdit(list[idx].text);
  if (text === null) return;
  if (!(await sealGuardConfirm(text))) return;   // shared seal guard on the edited note
  list[idx] = { ...list[idx], text, edited_at: nowIso() };
  if (await _anlPatch(caseId, { notes: JSON.stringify(list) })) window.flashSavedThen(() => refreshActivePanel());
}


// ── Notifications on status change ───────────────────────────────────────────
async function notifyStatusChange(c, newCode) {
  const label = CASE_STATUS[newCode]?.label || newCode;
  const entityName = `${petName(c)}${respName(c) ? ' vs ' + respName(c) : ''}`;
  await logActivity({ action: `advanced annulment case to ${label}`, entityType: 'annulments', entityName, contextType: 'annulments', contextId: c.id });
  const { data: rows } = await sb.from('user_roles').select('user_id').eq('role', 'super_admin');
  const uids = (rows || []).map(r => r.user_id);
  if (uids.length) notifyUsers(uids, _curUserId(), `Annulment ${entityName} — ${label}`, 'info', 'annulments', c.id);
}

// ── Big modal scaffolding (own overlay; the shared modal is only 500px) ──────
function _anlOverlay() {
  let ov = document.getElementById('anl-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'anl-overlay';
    ov.className = 'modal-overlay';
    ov.innerHTML = `<div class="modal anl-modal"><button class="modal-close" onclick="anlCloseModal()">×</button><div id="anl-modal-content"></div></div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) anlCloseModal(); });
  }
  return ov;
}
function _anlOpen(html) { _anlOverlay(); document.getElementById('anl-modal-content').innerHTML = html; document.getElementById('anl-overlay').classList.add('open'); }
function anlCloseModal() { document.getElementById('anl-overlay')?.classList.remove('open'); _M = null; }

// ── "Requirements for Annulment Types" help window ───────────────────────────
// A small dismissable window (its own overlay so it stacks ABOVE the case modal it's
// opened from). Dismiss via X, outside-click, or Escape. Static content from
// ANNULMENT_TYPE_HELP; reuses the shared .modal-overlay/.modal pattern (incl. its
// max-height + overflow-y scroll and dark-mode styling).
function _anlHelpContentHtml() {
  return ANNULMENT_TYPE_HELP.map(t => `
    <div style="margin-bottom:1.2rem;">
      <div style="font-family:'Cormorant Garamond',serif;font-size:16px;font-weight:600;color:var(--cardinal);margin-bottom:.4rem;">${_esc(t.title)}</div>
      ${t.paras.map(p => `<p style="font-size:13px;line-height:1.55;color:var(--navy);margin:0 0 .55rem;">${_esc(p)}</p>`).join('')}
    </div>`).join('');
}
function _anlHelpOverlay() {
  let ov = document.getElementById('anl-help-overlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'anl-help-overlay';
    ov.className = 'modal-overlay';
    ov.style.zIndex = '1100';   // above the case modal (.modal-overlay = 1000)
    ov.innerHTML = `<div class="modal" style="width:560px;max-width:94vw;">
      <button class="modal-close" onclick="anlCloseTypeHelp()" aria-label="Close">×</button>
      <div class="modal-title">Requirements for Annulment Types</div>
      <div id="anl-help-content"></div>
    </div>`;
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) anlCloseTypeHelp(); });   // outside-click
  }
  return ov;
}
function _anlHelpEsc(e) { if (e.key === 'Escape') { e.stopPropagation(); anlCloseTypeHelp(); } }
window.anlOpenTypeHelp = () => {
  const ov = _anlHelpOverlay();
  document.getElementById('anl-help-content').innerHTML = _anlHelpContentHtml();
  ov.classList.add('open');
  document.addEventListener('keydown', _anlHelpEsc);   // Escape
};
window.anlCloseTypeHelp = () => {
  document.getElementById('anl-help-overlay')?.classList.remove('open');
  document.removeEventListener('keydown', _anlHelpEsc);
};

// ── Create / Edit modal ──────────────────────────────────────────────────────
function openCaseCreate() {
  const type = 'formal';
  _M = { id: null, isEdit: false, type, advocateOther: false,
    docs: (_templates[type] || []).map(d => ({ name: d.name, received: false, deletable: d.deletable ?? true })),
    prev: [], linkedMarriage: null, linkedOcia: null, priorStatus: null };
  _anlOpen(buildCaseModalHtml(null));
  _hydrateModal();
}

function openCaseEdit(id) {
  const c = allCases.find(x => x.id === id);
  if (!c) return;
  _M = {
    id, isEdit: true, type: caseType(c),
    advocateOther: !c.advocate_id && !!c.advocate_name_override,
    docs: caseDocs(c),
    prev: Array.isArray(c.previous_annulments) ? JSON.parse(JSON.stringify(c.previous_annulments)) : [],
    linkedMarriage: c.linked_marriage_prep_id ? { id: c.linked_marriage_prep_id, label: _coupleLabel(c.linked_marriage_prep_id) } : null,
    linkedOcia: c.linked_ocia_id ? { id: c.linked_ocia_id, label: _ociaLabel(c.linked_ocia_id) } : null,
    priorStatus: c.status_code || 'prep',
  };
  _anlOpen(buildCaseModalHtml(c));
  _hydrateModal();
}

// Resolve linked Marriage/OCIA labels by id from the DB-backed display caches
// (warmed in loadCasesData) so they render even if those panels were never opened.
function _coupleLabel(id) { const r = getCoupleDisplay(id); return r ? `${r.groom || ''} & ${r.bride || ''}`.trim() : 'Marriage record'; }
function _ociaLabel(id)   { const r = getOciaDisplay(id); return r ? (r.name || 'OCIA record') : 'OCIA record'; }

// Advocate option source: the SAME people the shared formation helper offers —
// parish clergy (personnel.clergy) ∪ the Annulments program coordinator(s) — but
// returned as personnel records so the dropdown can store the FK id. Deduped by id.
function advocatePersonnel() {
  const byId = new Map();
  (store.personnel || []).filter(p => p.clergy && p.name).forEach(p => byId.set(p.id, p));
  _anlCoordinatorIds.forEach(id => { const p = (store.personnel || []).find(x => x.id === id); if (p && p.name) byId.set(p.id, p); });
  return [...byId.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function _row(...cells) { return `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cells.map(c => `<div style="flex:1;min-width:120px;">${c}</div>`).join('')}</div>`; }
function _input(id, label, val = '', type = 'text') { return `<label>${label}</label><input type="${type}" id="${id}" value="${_esc(val)}" />`; }
function _toggle(id, label, on, onchange = '') { return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:.75rem;"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${onchange ? `onchange="${onchange}"` : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" />${label}</label>`; }
function _sectionHead(t) { return `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--cardinal);margin:1.4rem 0 .5rem;border-bottom:.5px solid var(--stone);padding-bottom:4px;">${t}</div>`; }
function _subLabel(t) { return `<div style="font-size:11px;font-weight:600;color:#6B7280;margin-top:.75rem;">${t}</div>`; }
// The six baptismal-status checkboxes for a party (prefix 'pet' | 'resp'). Each box's
// onchange runs the shared exclusion + downstream logic. Greying is applied post-render.
function _bapStatusToggles(prefix, c) {
  return BAP_STATUS.map(o => `<label id="am-${prefix}-bap${o.n}-lbl" style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:.5rem;">
      <input type="checkbox" id="am-${prefix}-bap${o.n}" ${c?.[`${prefix}_bap_${o.suffix}`] ? 'checked' : ''} onchange="anlBapStatusChange('${prefix}')" style="width:15px;height:15px;accent-color:var(--cardinal);flex-shrink:0;" />${o.label}</label>`).join('');
}
// Baptism-location fields for a party (church / city / state(50) / country + affidavit).
// The country dropdown hides + clears the state for a non-US country (the one exception
// to "keep data"). prefix 'pet' | 'resp'; column source via BAP_LOC_COLS.
function _bapLocationFields(prefix, c) {
  const m = BAP_LOC_COLS[prefix];
  const country = c?.[m.country] || 'United States of America';
  const usa = country === 'United States of America';
  return `<div style="display:flex;gap:8px;flex-wrap:wrap;">
      <div style="flex:2;min-width:140px;">${_input(`am-${prefix}-bchurch`, 'Church of Baptism', c?.[m.church] || '')}</div>
      <div style="flex:1;min-width:110px;">${_input(`am-${prefix}-bcity`, 'Baptism City', c?.[m.city] || '')}</div>
      <div id="am-${prefix}-bstate-wrap" style="flex:1;min-width:110px;display:${usa ? 'block' : 'none'};">${stateSelect(`am-${prefix}-bstate`, c?.[m.state] || '')}</div>
      <div style="flex:1;min-width:120px;"><label>Country</label><select id="am-${prefix}-bcountry" onchange="anlOnBapCountryChange('${prefix}')">${COUNTRIES.map(co => `<option${country === co ? ' selected' : ''}>${co}</option>`).join('')}</select></div>
    </div>
    ${_toggle(`am-${prefix}-baffidavit`, 'Baptism by Affidavit', !!c?.[m.affidavit])}`;
}

function buildCaseModalHtml(c, opts = {}) {
  const inline = !!opts.inline;
  const isEdit = _M.isEdit;
  const advOpts = advocatePersonnel().map(p => `<option value="${p.id}"${c?.advocate_id === p.id ? ' selected' : ''}>${_esc(p.name)}</option>`).join('');

  let h = inline ? '' : `<div class="modal-title">${isEdit ? 'Edit Annulment Case' : 'New Annulment Case'}</div>`;

  // Section 1 — Type. The selected type drives which sections surface (see
  // typeSections / anlOnTypeChange) and seeds the document checklist. The "?" opens the
  // static "Requirements for Annulment Types" reference window (anlOpenTypeHelp).
  h += `<label style="display:flex;align-items:center;gap:6px;">Annulment Type
      <button type="button" onclick="anlOpenTypeHelp()" title="Requirements for Annulment Types" aria-label="Requirements for Annulment Types" style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;border:1px solid var(--cardinal);color:var(--cardinal);background:none;font-size:11px;font-weight:700;line-height:1;cursor:pointer;font-family:'Inter',sans-serif;padding:0;flex-shrink:0;">?</button></label>
    <select id="am-type" onchange="anlOnTypeChange(this.value)">
      ${ANNULMENT_TYPES.map(t => `<option value="${t.v}"${_M.type === t.v ? ' selected' : ''}>${t.label}</option>`).join('')}
    </select>`;

  // Section 2 — Advocate (directory-linked via advocate_id; Other = name override)
  h += _sectionHead('Advocate');
  h += `<label>Advocate</label>
    <select id="am-advocate" onchange="anlOnAdvocateChange(this.value)">
      <option value="">— Select —</option>${advOpts}
      <option value="__other"${_M.advocateOther ? ' selected' : ''}>Other…</option>
    </select>
    <div id="am-advocate-other-wrap" style="display:${_M.advocateOther ? 'block' : 'none'};">
      <label>Advocate name</label><input type="text" id="am-advocate-other" value="${_esc(c?.advocate_name_override || '')}" placeholder="Name (no directory entry created)" />
    </div>`;

  // Section 3 — Petitioner
  h += _sectionHead('Petitioner');
  h += _row(_input('am-pet-first', 'First Name', c?.petitioner_first || ''), _input('am-pet-middle', 'Middle', c?.petitioner_middle || ''), _input('am-pet-last', 'Last Name', c?.petitioner_last || ''), _input('am-pet-maiden', 'Maiden', c?.petitioner_maiden || ''));
  h += _input('am-pet-street', 'Street Address', c?.petitioner_street || '');
  h += _row(_input('am-pet-city', 'City', c?.petitioner_city || ''), stateSelect('am-pet-state', c?.petitioner_state || ''), _input('am-pet-zip', 'ZIP', c?.petitioner_zip || ''));
  h += _row(_input('am-pet-cell', 'Cell Phone', c?.petitioner_cell || c?.contact_phone || '', 'tel'), _input('am-pet-email', 'Email', c?.petitioner_email || c?.contact_email || ''));
  h += _input('am-pet-dob', 'Date of Birth', c?.petitioner_dob && /^\d{4}-\d{2}-\d{2}/.test(c.petitioner_dob) ? c.petitioner_dob.slice(0, 10) : '', 'date');
  // Petitioner baptismal status — six booleans with symmetric mutual-exclusion. When
  // (5) Never or (6) Non-Religious is checked, the baptism-location fields below grey
  // out and the petitioner Baptismal Document drops from Required Documents (the
  // respondent baptism section then surfaces — see anlBapStatusChange).
  h += _subLabel('Baptismal Status');
  h += _bapStatusToggles('pet', c);
  // Petitioner baptism location — PLAIN, always-shown petitioner fields (greyed when
  // 5/6). Church, City, State, Country + by-affidavit. Viewer adds the doc lock-gate.
  h += _bapLocationFields('pet', c);

  // Section 4 — Respondent
  h += _sectionHead('Respondent');
  h += _row(_input('am-resp-first', 'First Name', c?.respondent_first || ''), _input('am-resp-middle', 'Middle', c?.respondent_middle || ''), _input('am-resp-last', 'Last Name', c?.respondent_last || ''), _input('am-resp-maiden', 'Maiden', c?.respondent_maiden || ''));
  // Respondent baptism section — appears ONLY when the PETITIONER is unbaptized
  // (pet 5/6). Hidden-but-kept otherwise (data preserved; reappears unchanged). Mirrors
  // the petitioner's six booleans + baptism location; when the RESPONDENT'S OWN 5/6 is
  // checked, the respondent baptism fields grey + the respondent doc drops (two-layer).
  const respBapShow = !!(c?.pet_bap_never || c?.pet_bap_nonreligious);
  h += `<div id="am-resp-bap-section" style="display:${respBapShow ? 'block' : 'none'};">`;
  h += _subLabel('Baptismal Status');
  h += _bapStatusToggles('resp', c);
  h += _bapLocationFields('resp', c);
  h += `</div>`;

  // Section 5 — Marriage. Order: church (relabeled, top) + Non-Church toggle that
  // hides it; then date, county, city, State (50-state dropdown), Country (dropdown,
  // default USA). State hides + clears when Country is not USA. No ZIP.
  h += _sectionHead('Marriage Information');
  h += _toggle('am-mar-nonchurch', 'Non-Church Wedding', !!c?.non_church_wedding, 'anlOnMarNonChurchToggle()');
  h += `<div id="am-mar-church-wrap" style="display:${c?.non_church_wedding ? 'none' : 'block'};">${_input('am-mar-church', 'Parish/Church where Marriage Occured', c?.marriage_church || '')}</div>`;
  h += _input('am-mar-date', 'Date of Marriage', c?.marriage_date || '', 'date');
  h += _row(_input('am-mar-county', 'County', c?.marriage_county || ''), _input('am-mar-city', 'City', c?.marriage_city || ''));
  const marCountry = c?.marriage_country || 'United States of America';
  const marIsUSA = marCountry === 'United States of America';
  h += `<div style="display:flex;gap:8px;flex-wrap:wrap;">
    <div id="am-mar-state-wrap" style="flex:1;min-width:120px;display:${marIsUSA ? 'block' : 'none'};">${stateSelect('am-mar-state', c?.marriage_state || '')}</div>
    <div style="flex:1;min-width:120px;"><label>Country</label><select id="am-mar-country" onchange="anlOnMarCountryChange()">${COUNTRIES.map(co => `<option${marCountry === co ? ' selected' : ''}>${co}</option>`).join('')}</select></div>
  </div>`;

  // Section 6 — Tribunal
  h += _sectionHead('Tribunal');
  h += _row(_input('am-trib-diocese', 'Filed with the Diocese of', c?.tribunal_diocese || ''), _input('am-trib-filed', 'Date Filed', c?.date_filed || '', 'date'));

  // Section 7 — Previous annulments
  h += _sectionHead('Previous Annulments');
  h += _toggle('am-prev-toggle', 'Previous Annulment?', _M.prev.length > 0, 'anlOnPrevToggle()');
  h += `<div id="am-prev-wrap" style="display:${_M.prev.length > 0 ? 'block' : 'none'};margin-top:.5rem;"></div>`;

  // Section 8 — Briefer (formal only). briefer_process is a boolean ON a Formal case
  // (not a separate type). When on, the RESPONDENT becomes the co-petitioner BY
  // DEFINITION — there is no separate co-petitioner input; it is derived from the
  // respondent's name (stored in sync + displayed derived in the viewer).
  h += `<div id="am-briefer-section" style="display:${_M.type === 'formal' ? 'block' : 'none'};">`;
  h += _sectionHead('Briefer Process');
  h += _toggle('am-briefer', 'Briefer Process', !!c?.briefer_process, 'anlOnBrieferToggle()');
  h += `<div id="am-briefer-info" style="display:${c?.briefer_process ? 'block' : 'none'};" class="anl-info-box">⚠️ The Briefer Process (Processus Brevior) requires:<br>• Both parties must jointly sign the petition (the respondent joins as co-petitioner)<br>• The case is decided by the Bishop, not a collegiate tribunal<br>• Grounds must be evident from the facts</div>`;
  h += `</div>`;

  // Section 9 — Documents
  h += _sectionHead('Required Documents');
  h += `<div id="am-docs"></div>
    <div style="display:flex;gap:6px;margin-top:6px;">
      <input type="text" id="am-doc-new" placeholder="Add custom document…" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();anlAddDoc();}" />
      <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="anlAddDoc()">+ Add</button>
    </div>`;

  // Edit-only sections
  if (isEdit) {
    h += _sectionHead('Status & Outcome');
    const statusOpts = [['prep', 'Preparing'], ['tribunal', 'In Tribunal'], ['affirm', 'Affirmative Judgement'], ['negative', 'Negative Judgement'], ['archived', 'Inactive']]
      .map(([v, l]) => `<option value="${v}"${(c?.status_code || 'prep') === v ? ' selected' : ''}>${l}</option>`).join('');
    h += `<label>Status</label><select id="am-status" onchange="anlOnStatusChange(this.value)">${statusOpts}</select>`;
    const isJudg = c?.status_code === 'affirm' || c?.status_code === 'negative';
    h += `<div id="am-jf-wrap" style="display:${isJudg ? 'block' : 'none'};">${_toggle('am-jf', 'Judgement Final', c?.judgement_finalized === 'yes')}</div>`;
    h += `<div id="am-vetitum-wrap" style="display:${c?.status_code === 'affirm' ? 'block' : 'none'};">
      ${_toggle('am-vetitum', 'Vetitum Attached', !!c?.vetitum, 'anlOnVetitumToggle()')}
      <div id="am-vetitum-notes-wrap" style="display:${c?.vetitum ? 'block' : 'none'};"><label>Vetitum notes / conditions</label><textarea id="am-vetitum-notes" rows="2">${_esc(c?.vetitum_notes || '')}</textarea></div>
    </div>`;
    h += _toggle('am-archive', 'Archive this case', !!c?.archived);

    // Unified "Linked Records": one section + one search over Annulment + OCIA + Marriage.
    // Picks route by type — annulment → case-group (mechanism A), OCIA/Marriage → direct
    // record_links pair (mechanism B). Edit-safe (re-renders only its own block).
    h += _sectionHead('Linked Records');
    h += (typeof window !== 'undefined' && window._anlLinkedRecordsEditor) ? window._anlLinkedRecordsEditor(c) : '';
  }

  // Actions — only for the create MODAL. The inline edit form lives in the shell's
  // detail pane, which supplies its own Save / Cancel / Delete buttons.
  if (!inline) {
    h += `<div class="modal-actions" style="justify-content:space-between;">
      ${isEdit ? `<button class="btn-delete" onclick="anlDeleteCase('${_M.id}')">Delete</button>` : '<span></span>'}
      <div style="display:flex;gap:8px;">
        <button class="btn-secondary" onclick="anlCloseModal()">Cancel</button>
        <button class="btn-primary" onclick="anlSaveCase()">${isEdit ? 'Save' : 'Create File'}</button>
      </div>
    </div>`;
  }
  return h;
}

// Post-render hydration helpers (called after _anlOpen sets innerHTML)
function _hydrateModal() {
  // Apply baptismal-status exclusion + downstream + cross-party visibility from the
  // stored values, then sync docs (which renders the checklist).
  anlApplyBapExclusion('pet'); anlApplyBapExclusion('resp');
  anlSyncRespBaptismVisibility();
  anlApplyBaptismDownstream('pet'); anlApplyBaptismDownstream('resp');
  _syncBaptismDocs();
  renderModalPrev();
  if (_M.isEdit) { renderLinkedChip('marriage'); renderLinkedChip('ocia'); }
}

function renderModalDocs() {
  const el = document.getElementById('am-docs'); if (!el) return;
  // Petitioner 5/6 → hide the petitioner Baptismal Document (kept in _M.docs so data
  // is preserved; it reappears if 5/6 is unchecked). Index is preserved for handlers.
  const hidePetBap = _partyNoBaptism('pet');
  const petBapIdx = _M.docs.findIndex(d => /baptism/i.test(d.name) && !/respondent/i.test(d.name));
  const rows = _M.docs.map((d, i) => {
    if (hidePetBap && i === petBapIdx) return '';
    return `
    <div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
      <input type="checkbox" ${d.received ? 'checked' : ''} onchange="anlDocReceived(${i},this.checked)" style="width:15px;height:15px;accent-color:var(--cardinal);" />
      <span style="font-size:13px;color:var(--navy);">${_esc(d.name)}</span>
      ${docCheckStampHtml(d)}
      ${d.deletable ? `<button onclick="anlRemoveDoc(${i})" title="Remove" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;margin-left:8px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>` : `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;margin-left:8px;" title="Required"></i>`}
    </div>`;
  }).join('');
  el.innerHTML = rows.trim() ? rows : `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No documents.</div>`;
}

function renderModalPrev() {
  const wrap = document.getElementById('am-prev-wrap'); if (!wrap) return;
  wrap.innerHTML = _M.prev.map((p, i) => `
    <div style="display:flex;gap:8px;align-items:flex-end;margin-bottom:8px;">
      <div style="flex:1;">${_input(`am-prev-spouse-${i}`, 'Previous Spouse Name', p.spouse_name || '')}</div>
      <div style="flex:1;">${_input(`am-prev-diocese-${i}`, 'Granted by the (Arch)Diocese of', p.diocese || '')}</div>
      <button onclick="anlRemovePrev(${i})" title="Remove" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:16px;padding:0 0 6px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>
    </div>`).join('') + `<button class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;" onclick="anlAddPrev()">+ Add another</button>`;
}

function _syncPrevFromDom() {
  _M.prev = _M.prev.map((_, i) => ({
    spouse_name: document.getElementById(`am-prev-spouse-${i}`)?.value.trim() || '',
    diocese: document.getElementById(`am-prev-diocese-${i}`)?.value.trim() || '',
  }));
}

// Modal interaction handlers
function anlOnTypeChange(val) {
  _syncPrevFromDom();
  _M.type = val;
  // Briefer is a Formal-only flag; gate its section to Formal.
  const briefer = document.getElementById('am-briefer-section'); if (briefer) briefer.style.display = val === 'formal' ? 'block' : 'none';
  // (Baptismal-status visibility is cross-party, not type-driven: the respondent
  // baptism section is governed by the petitioner's 5/6 status — see anlBapStatusChange.)
  // Document checklist reconciliation with the new type's template.
  if (!_M.isEdit) {
    // New case: just reseed from the template.
    _M.docs = (_templates[val] || []).map(d => ({ name: d.name, received: false, deletable: d.deletable ?? true }));
  } else {
    // Editing: MERGE — preserve every existing doc (checked state, custom adds, and
    // the old type's docs), and APPEND the new type's template docs that aren't
    // already present (by name). Nothing already on the file is removed.
    _syncDocsReceivedFromDom();
    const have = new Set(_M.docs.map(d => d.name));
    (_templates[val] || []).forEach(d => { if (!have.has(d.name)) _M.docs.push({ name: d.name, received: false, deletable: d.deletable ?? true }); });
  }
  renderModalDocs();
}
// Capture current checkbox state from the DOM before re-rendering the doc list (so
// a merge/re-render never loses a just-toggled box).
function _syncDocsReceivedFromDom() {
  const boxes = document.querySelectorAll('#am-docs input[type=checkbox]');
  boxes.forEach((b, i) => { if (_M.docs[i]) applyDocCheck(_M.docs[i], b.checked); });
}
function anlOnAdvocateChange(val) {
  _M.advocateOther = val === '__other';
  document.getElementById('am-advocate-other-wrap').style.display = _M.advocateOther ? 'block' : 'none';
}
function anlOnStatusChange(val) {
  document.getElementById('am-jf-wrap').style.display = (val === 'affirm' || val === 'negative') ? 'block' : 'none';
  document.getElementById('am-vetitum-wrap').style.display = val === 'affirm' ? 'block' : 'none';
}
window.anlOnBrieferToggle = () => {
  const on = document.getElementById('am-briefer').checked;
  document.getElementById('am-briefer-info').style.display = on ? 'block' : 'none';
};

// ── Baptismal-status interactions (shared by both parties) ────────────────────
// Symmetric mutual-exclusion: a box is disabled (greyed) iff some OTHER checked box
// excludes it (BAP_EXCL is symmetric, so this is order-independent + both-directions).
// A checked box is never disabled (so it can always be unchecked to re-enable others).
function anlApplyBapExclusion(prefix) {
  const checked = [];
  for (let n = 1; n <= 6; n++) if (_bapChecked(prefix, n)) checked.push(n);
  for (let j = 1; j <= 6; j++) {
    const el = document.getElementById(`am-${prefix}-bap${j}`); if (!el) continue;
    const disable = !el.checked && checked.some(i => i !== j && BAP_EXCL[i].includes(j));
    el.disabled = disable;
    const lbl = document.getElementById(`am-${prefix}-bap${j}-lbl`);
    if (lbl) { lbl.style.opacity = disable ? '0.45' : ''; lbl.style.cursor = disable ? 'not-allowed' : 'pointer'; }
  }
}
// Downstream of a party's OWN 5/6: grey (disable, keep data) that party's baptism
// location fields + by-affidavit. Document removal is handled in _syncBaptismDocs.
function anlApplyBaptismDownstream(prefix) {
  const off = _partyNoBaptism(prefix);
  ['bchurch', 'bcity', 'bstate', 'bcountry', 'baffidavit'].forEach(suf => {
    const el = document.getElementById(`am-${prefix}-${suf}`); if (!el) return;
    el.disabled = off;
    el.style.opacity = off ? '0.45' : '';
    const lbl = el.closest('label'); if (lbl) lbl.style.opacity = off ? '0.45' : '';
  });
}
// Cross-party: the respondent baptism section appears ONLY when the PETITIONER is
// unbaptized (pet 5/6). Hidden-but-kept otherwise (display:none preserves field data).
function anlSyncRespBaptismVisibility() {
  const sec = document.getElementById('am-resp-bap-section');
  if (sec) sec.style.display = _partyNoBaptism('pet') ? 'block' : 'none';
}
// Add/remove the dynamic baptism docs in _M.docs (then re-render the checklist):
//  • Petitioner baptism doc — a template doc; HIDDEN at render when pet 5/6 (kept in data).
//  • Respondent baptism doc — present only when pet 5/6 AND respondent NOT 5/6.
function _syncBaptismDocs() {
  const wantResp = _partyNoBaptism('pet') && !_partyNoBaptism('resp');
  const idx = _M.docs.findIndex(d => /baptism/i.test(d.name) && /respondent/i.test(d.name));
  if (wantResp && idx < 0) _M.docs.push({ name: RESP_BAPTISM_DOC, received: false, deletable: true });
  else if (!wantResp && idx >= 0) _M.docs.splice(idx, 1);
  renderModalDocs();
}
// Single entry point wired to every status checkbox's onchange.
window.anlBapStatusChange = (prefix) => {
  anlApplyBapExclusion(prefix);
  anlSyncRespBaptismVisibility();        // petitioner 5/6 governs the respondent section
  anlApplyBaptismDownstream('pet');
  anlApplyBaptismDownstream('resp');
  _syncBaptismDocs();                     // re-renders the checklist (also hides pet baptism doc)
};
// Baptism country dropdown (per party): non-US hides + clears the 50-state dropdown.
window.anlOnBapCountryChange = (prefix) => {
  const usa = document.getElementById(`am-${prefix}-bcountry`)?.value === 'United States of America';
  const w = document.getElementById(`am-${prefix}-bstate-wrap`); if (w) w.style.display = usa ? 'block' : 'none';
  const sel = document.getElementById(`am-${prefix}-bstate`); if (sel && !usa) sel.value = '';
};
window.anlOnVetitumToggle = () => { const on = document.getElementById('am-vetitum').checked; document.getElementById('am-vetitum-notes-wrap').style.display = on ? 'block' : 'none'; };
// Non-Church Wedding hides the parish/church field (a civil wedding has no parish).
window.anlOnMarNonChurchToggle = () => {
  const on = document.getElementById('am-mar-nonchurch').checked;
  const w = document.getElementById('am-mar-church-wrap'); if (w) w.style.display = on ? 'none' : 'block';
};
// The 50-state dropdown only applies to US marriages: hide it for a non-US country
// and clear any selected state so a US state can't stay attached to a foreign country.
window.anlOnMarCountryChange = () => {
  const usa = (document.getElementById('am-mar-country')?.value === 'United States of America');
  const w = document.getElementById('am-mar-state-wrap'); if (w) w.style.display = usa ? 'block' : 'none';
  const sel = document.getElementById('am-mar-state'); if (sel && !usa) sel.value = '';
};
window.anlOnPrevToggle = () => {
  const on = document.getElementById('am-prev-toggle').checked;
  document.getElementById('am-prev-wrap').style.display = on ? 'block' : 'none';
  if (on && !_M.prev.length) { _M.prev = [{ spouse_name: '', diocese: '' }]; renderModalPrev(); }
};
function anlAddPrev() { _syncPrevFromDom(); _M.prev.push({ spouse_name: '', diocese: '' }); renderModalPrev(); }
function anlRemovePrev(i) { _syncPrevFromDom(); _M.prev.splice(i, 1); renderModalPrev(); }
function anlDocReceived(i, v) { applyDocCheck(_M.docs[i], v); }
function anlRemoveDoc(i) { _M.docs.splice(i, 1); renderModalDocs(); }
function anlAddDoc() {
  const inp = document.getElementById('am-doc-new'); const name = (inp?.value || '').trim();
  if (!name) return;
  _M.docs.push({ name, received: false, deletable: true }); inp.value = ''; renderModalDocs();
}

// Linked record search
async function anlLinkSearch(kind) {
  const q = (document.getElementById(`am-link-${kind === 'marriage' ? 'mar' : 'ocia'}`)?.value || '').trim();
  const box = document.getElementById(`am-link-${kind === 'marriage' ? 'mar' : 'ocia'}-results`);
  if (!box) return;
  if (q.length < 2) { box.style.display = 'none'; return; }
  const safe = q.replace(/[%_,()'"*]/g, ' ');
  let rows = [];
  if (kind === 'marriage') {
    const { data } = await sb.from('couples').select('id, groom, bride').or(`groom.ilike.%${safe}%,bride.ilike.%${safe}%`).limit(6);
    rows = (data || []).map(r => ({ id: r.id, label: `${r.groom || ''} & ${r.bride || ''}`.trim() }));
  } else {
    const { data } = await sb.from('sacramental_ocia').select('id, name').ilike('name', `%${safe}%`).limit(6);
    rows = (data || []).map(r => ({ id: r.id, label: r.name || 'OCIA record' }));
  }
  if (!rows.length) { box.innerHTML = `<div style="padding:.5rem .7rem;font-size:12px;color:#9CA3AF;">No matches</div>`; box.style.display = 'block'; return; }
  box.innerHTML = rows.map(r => `<div class="anl-link-opt" onclick="anlSelectLinked('${kind}','${r.id}','${_esc(r.label).replace(/'/g, '&#39;')}')">${_esc(r.label)}</div>`).join('');
  box.style.display = 'block';
}
function anlSelectLinked(kind, id, label) {
  if (kind === 'marriage') _M.linkedMarriage = { id, label }; else _M.linkedOcia = { id, label };
  document.getElementById(`am-link-${kind === 'marriage' ? 'mar' : 'ocia'}-results`).style.display = 'none';
  document.getElementById(`am-link-${kind === 'marriage' ? 'mar' : 'ocia'}`).value = '';
  renderLinkedChip(kind);
}
function anlRemoveLinked(kind) { if (kind === 'marriage') _M.linkedMarriage = null; else _M.linkedOcia = null; renderLinkedChip(kind); }
function renderLinkedChip(kind) {
  const link = kind === 'marriage' ? _M.linkedMarriage : _M.linkedOcia;
  const el = document.getElementById(`am-link-${kind === 'marriage' ? 'mar' : 'ocia'}-chip`);
  if (!el) return;
  if (!link) { el.innerHTML = ''; return; }
  const navFn = kind === 'marriage' ? 'expandCouple' : 'expandOcia';
  el.innerHTML = `<span style="display:inline-flex;align-items:center;gap:8px;background:#1C2B3A;color:#fff;border-radius:14px;padding:3px 8px 3px 12px;font-size:12px;">
    <span>${_esc(link.label)}</span>
    <button onclick="window.${navFn}('${link.id}')" title="Open record" style="background:none;border:none;color:#C9A84C;cursor:pointer;font-size:12px;padding:0;"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
    <button onclick="anlRemoveLinked('${kind}')" title="Unlink" style="background:none;border:none;color:#cdd6df;cursor:pointer;font-size:12px;padding:0;">×</button>
  </span>`;
}

// ── Save ─────────────────────────────────────────────────────────────────────
function _v(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function _chk(id) { return !!document.getElementById(id)?.checked; }

// Build the common case payload from the open form (create modal OR inline edit).
function _anlReadPayload() {
  _syncPrevFromDom(); _syncDocsReceivedFromDom();
  const type = _M.type;
  const advSel = document.getElementById('am-advocate')?.value || '';
  const respFull = `${_v('am-resp-first')} ${_v('am-resp-last')}`.trim() || null;
  const payload = {
    annulment_type: type,
    briefer_process: type === 'formal' ? _chk('am-briefer') : false,
    // Briefer: the RESPONDENT is the co-petitioner by definition — no separate input.
    // Keep the legacy co_petitioner column in sync (derived from the respondent name);
    // null when not a Briefer. The viewer displays it derived from the respondent.
    co_petitioner: (type === 'formal' && _chk('am-briefer')) ? respFull : null,
    // Advocate stores to its own columns: FK id for a directory pick, free-text
    // override for "Other". (The dead `preparer` column is never written here.)
    advocate_id: advSel && advSel !== '__other' ? advSel : null,
    advocate_name_override: advSel === '__other' ? (_v('am-advocate-other') || null) : null,
    petitioner_first: _v('am-pet-first') || null, petitioner_middle: _v('am-pet-middle') || null,
    petitioner_last: _v('am-pet-last') || null, petitioner_maiden: _v('am-pet-maiden') || null,
    petitioner_street: _v('am-pet-street') || null, petitioner_city: _v('am-pet-city') || null,
    petitioner_state: _v('am-pet-state') || null, petitioner_zip: _v('am-pet-zip') || null,
    petitioner_cell: normalizePhone(_v('am-pet-cell')) || null, petitioner_email: _v('am-pet-email') || null,
    petitioner_dob: _v('am-pet-dob') || null,
    petitioner_baptism_church: _v('am-pet-bchurch') || null, petitioner_baptism_city: _v('am-pet-bcity') || null,
    petitioner_baptism_state: (_v('am-pet-bcountry') === 'United States of America') ? (_v('am-pet-bstate') || null) : null,
    petitioner_baptism_country: _v('am-pet-bcountry') || null,
    petitioner_baptism_by_affidavit: _chk('am-pet-baffidavit'),
    respondent_first: _v('am-resp-first') || null, respondent_middle: _v('am-resp-middle') || null,
    respondent_last: _v('am-resp-last') || null, respondent_maiden: _v('am-resp-maiden') || null,
    // Respondent baptism location (mirrors petitioner; non-US clears state).
    respondent_baptism_church: _v('am-resp-bchurch') || null, respondent_baptism_city: _v('am-resp-bcity') || null,
    respondent_baptism_state: (_v('am-resp-bcountry') === 'United States of America') ? (_v('am-resp-bstate') || null) : null,
    respondent_baptism_country: _v('am-resp-bcountry') || null,
    respondent_baptism_by_affidavit: _chk('am-resp-baffidavit'),
    // Six baptismal-status booleans per party (pet_bap_* / resp_bap_*).
    ...Object.fromEntries(BAP_STATUS.flatMap(o => [
      [`pet_bap_${o.suffix}`, _chk(`am-pet-bap${o.n}`)],
      [`resp_bap_${o.suffix}`, _chk(`am-resp-bap${o.n}`)],
    ])),
    // Marriage location (restructured): church only when NOT a non-church wedding;
    // State only when Country is USA (cleared otherwise). marriage_state_country and
    // marriage_ceremony_type are no longer written (dead columns).
    non_church_wedding: _chk('am-mar-nonchurch'),
    marriage_church: _chk('am-mar-nonchurch') ? null : (_v('am-mar-church') || null),
    marriage_date: _v('am-mar-date') || null,
    marriage_county: _v('am-mar-county') || null,
    marriage_city: _v('am-mar-city') || null,
    marriage_country: _v('am-mar-country') || null,
    marriage_state: (_v('am-mar-country') === 'United States of America') ? (_v('am-mar-state') || null) : null,
    tribunal_diocese: _v('am-trib-diocese') || null, date_filed: _v('am-trib-filed') || null,
    previous_annulments: _chk('am-prev-toggle') ? _M.prev.filter(p => p.spouse_name || p.diocese) : [],
    documents: _M.docs,
    // keep legacy text fields in sync so old code / fallbacks stay correct
    petitioner: `${_v('am-pet-first')} ${_v('am-pet-last')}`.trim() || null,
    respondent: `${_v('am-resp-first')} ${_v('am-resp-last')}`.trim() || null,
    updated_at: nowIso(),
  };
  return { ok: !!(payload.petitioner_last || payload.petitioner_first), payload };
}

// Apply edit-only fields (status / judgement / vetitum / archive / links) and the
// AUTO timeline milestones. Mutates `payload`; returns { newStatus, statusChanged }.
function _anlApplyEditFields(payload, prior) {
  const newStatus = document.getElementById('am-status')?.value || prior?.status_code || 'prep';
  payload.status_code = newStatus;
  const finalizedNow = (newStatus === 'affirm' || newStatus === 'negative') ? (_chk('am-jf') ? 'yes' : 'no') : (prior?.judgement_finalized || null);
  payload.judgement_finalized = finalizedNow;
  payload.vetitum = newStatus === 'affirm' ? _chk('am-vetitum') : false;
  payload.vetitum_notes = payload.vetitum ? (_v('am-vetitum-notes') || null) : null;
  payload.archived = _chk('am-archive');
  // Cross-panel links (Marriage / OCIA) now live in record_links (mechanism B, edited
  // via the "Linked Records" section), not these legacy columns — no longer written.

  // Auto-generated timeline milestones (added by the system, never user-chosen):
  //   • Submitted to Tribunal — on status change into 'tribunal' (In Tribunal)
  //   • Affirmative Judgement / Negative Judgement — on status change into that state
  //   • Case Closed — when judgement_finalized transitions no → yes
  // No auto-REMOVAL when a flag reverts (deliberate — the user deletes by hand).
  const tl = _rawTimeline(prior);
  const stamp = (text) => tl.push({ type: 'auto', text, created_at: nowIso(), created_by: _curUserId() });
  const statusChanged = prior && prior.status_code !== newStatus;
  if (statusChanged && newStatus === 'tribunal') stamp('Submitted to Tribunal');
  if (statusChanged && newStatus === 'affirm') stamp('Affirmative Judgement');
  if (statusChanged && newStatus === 'negative') stamp('Negative Judgement');
  const justFinalized = finalizedNow === 'yes' && (prior?.judgement_finalized !== 'yes' && prior?.judgement_finalized !== true);
  if (justFinalized) stamp('Case Closed');
  payload.timeline = tl;
  return { newStatus, statusChanged };
}

// Create flow (modal).
async function anlSaveCase() {
  const r = _anlReadPayload();
  if (!r.ok) { alert('Petitioner name is required.'); return; }
  const { payload } = r;
  if (_M.isEdit) {   // safety: the modal is create-only now, but keep edit correct
    const res = await anlSaveEdit(_M.id);
    if (res.ok) { window.flashSavedThen(() => { anlCloseModal(); refreshActivePanel(); }); }
    return;
  }
  payload.status_code = 'prep';
  payload.judgement_finalized = null;
  payload.archived = false;
  payload.timeline = [{ type: 'auto', text: 'Case Opened', created_at: nowIso(), created_by: _curUserId() }];
  const { error } = await insertWithRetry('annulment_cases', payload);
  if (error) { reportWriteError('annulment insert', error); return; }
  await logActivity({ action: 'opened annulment case', entityType: 'annulments', entityName: payload.petitioner || 'New case', contextType: 'annulments' });
  window.flashSavedThen(async () => { anlCloseModal(); await loadCasesData(); refreshActivePanel(); });
}

// ── Shell config hooks (inline edit form + save/delete) ──────────────────────
export function buildAnlEditForm(c) {
  _M = {
    id: c.id, isEdit: true, type: caseType(c),
    advocateOther: !c.advocate_id && !!c.advocate_name_override,
    docs: caseDocs(c),
    prev: Array.isArray(c.previous_annulments) ? JSON.parse(JSON.stringify(c.previous_annulments)) : [],
    linkedMarriage: c.linked_marriage_prep_id ? { id: c.linked_marriage_prep_id, label: _coupleLabel(c.linked_marriage_prep_id) } : null,
    linkedOcia: c.linked_ocia_id ? { id: c.linked_ocia_id, label: _ociaLabel(c.linked_ocia_id) } : null,
    priorStatus: c.status_code || 'prep',
  };
  const html = buildCaseModalHtml(c, { inline: true });
  setTimeout(() => _hydrateModal(), 0);
  return html;
}

export async function anlSaveEdit(id) {
  const r = _anlReadPayload();
  if (!r.ok) { alert('Petitioner name is required.'); return { ok: false }; }
  const { payload } = r;
  const prior = allCases.find(c => c.id === id);
  const { newStatus, statusChanged } = _anlApplyEditFields(payload, prior);
  // Capture the finalize TRANSITION before Object.assign overwrites prior's flag
  // (judgement_finalized is the string 'yes'/'no'; mirrors _anlApplyEditFields:justFinalized).
  const justFinalized = payload.judgement_finalized === 'yes'
    && prior?.judgement_finalized !== 'yes' && prior?.judgement_finalized !== true;
  const { error } = await withWriteRetry(() => sb.from('annulment_cases').update(payload).eq('id', id), { kind: 'update' });
  if (error) { reportWriteError('annulment update', error); return { ok: false }; }
  if (prior) Object.assign(prior, payload);
  await logActivity({ action: 'updated annulment case', entityType: 'annulments', entityName: payload.petitioner || 'Case', contextType: 'annulments', contextId: id });
  if (statusChanged && prior) await notifyStatusChange(prior, newStatus);
  // Notify on the judgement-finalized transition (status ∈ {affirm,negative}). Annulments
  // are cross-linkable (record_links + case-group) and add the advocate door.
  if (justFinalized && (newStatus === 'affirm' || newStatus === 'negative')) {
    const { data: { user } } = await sb.auth.getUser();
    notifySacramentEvent({
      keys: ['annulments'], parishId: prior?.parish_id ?? null, advocates: true,
      originType: 'annulment', originId: id, actorUserId: user?.id,
      message: `${payload.petitioner || 'Case'} Annulment — ${newStatus === 'affirm' ? 'Affirmative' : 'Negative'} Judgement finalized`,
      type: 'success', module: 'annulments', record_id: id,
    });
  }
  await loadCasesData();
  return { ok: true };
}

export async function anlDeleteRec(id) {
  if (!confirm('Permanently delete this case? This cannot be undone.')) return { ok: false };
  // Capture the display name BEFORE deletion — the record is gone afterward.
  const _c = allCases.find(x => x.id === id);
  const _name = _c ? (_c.respondent ? `${_c.petitioner || '?'} v. ${_c.respondent}` : (_c.petitioner || 'annulment case')) : 'annulment case';
  const { error } = await deleteWithRetry(() => sb.from('annulment_cases').delete().eq('id', id));
  if (error) { reportWriteError('annulment delete', error); return { ok: false }; }
  allCases = allCases.filter(x => x.id !== id);
  store.allCases = allCases;
  await logActivity({ action: 'deleted annulment case', entityType: 'annulments', entityName: _name, contextType: 'annulments' });
  renderAnnulmentAlerts();
  return { ok: true };
}

async function anlDeleteCase(id) {
  const res = await anlDeleteRec(id);
  if (res.ok) { anlCloseModal(); refreshActivePanel(); }
}

// ── Template settings ────────────────────────────────────────────────────────
let _tplState = null, _tplActive = 'formal';
function openTemplateSettings() {
  _tplState = JSON.parse(JSON.stringify(_templates));
  _tplActive = 'formal';
  _anlOpen(buildTemplateModalHtml());
  renderTplDocs();
}
function buildTemplateModalHtml() {
  const tabs = ANNULMENT_TYPES.map(t => `<button class="anl-tpl-tab${_tplActive === t.v ? ' active' : ''}" onclick="anlTplTab('${t.v}')">${t.badge}</button>`).join('');
  return `<div class="modal-title">Document Templates</div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:1rem;border-bottom:.5px solid var(--stone);padding-bottom:8px;">${tabs}</div>
    <div style="font-size:12px;color:#6B7280;margin-bottom:8px;">🔒 Locked documents are required and cannot be removed.</div>
    <div id="anl-tpl-docs"></div>
    <div style="display:flex;gap:6px;margin-top:8px;">
      <input type="text" id="anl-tpl-new" placeholder="Add document…" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();anlTplAddDoc();}" />
      <button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="anlTplAddDoc()">+ Add</button>
    </div>
    <div style="font-size:12px;color:#6B7280;font-style:italic;margin-top:1rem;">Template changes apply to new cases only. Existing cases are not affected.</div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="anlCloseModal()">Cancel</button>
      <button class="btn-primary" onclick="anlTplSave()">Save Template</button>
    </div>`;
}
function renderTplDocs() {
  const el = document.getElementById('anl-tpl-docs'); if (!el) return;
  const docs = _tplState[_tplActive] || [];
  el.innerHTML = docs.map((d, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:4px 0;">
      <span style="flex:1;font-size:13px;color:var(--navy);">${_esc(d.name)}</span>
      ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required (non-deletable)"></i>` : `<button onclick="anlTplRemove(${i})" title="Remove" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:14px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>`}
    </div>`).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No documents.</div>`;
}
function anlTplTab(v) { _tplActive = v; document.querySelectorAll('.anl-tpl-tab').forEach(b => b.classList.remove('active')); event.target.classList.add('active'); renderTplDocs(); }
function anlTplAddDoc() { const inp = document.getElementById('anl-tpl-new'); const name = (inp?.value || '').trim(); if (!name) return; (_tplState[_tplActive] = _tplState[_tplActive] || []).push({ name, deletable: true }); inp.value = ''; renderTplDocs(); }
function anlTplRemove(i) { _tplState[_tplActive].splice(i, 1); renderTplDocs(); }
async function anlTplSave() {
  const docs = _tplState[_tplActive] || [];
  const { error } = await sb.from('annulment_templates').upsert({ annulment_type: _tplActive, documents: docs, updated_at: nowIso() }, { onConflict: 'annulment_type' });
  if (error) { alert('Save failed: ' + error.message); return; }
  _templates[_tplActive] = docs;
  window.flashSaved();   // shared green "Saved ✓" confirmation
}

Object.assign(window, {
  openCaseCreate, openCaseEdit, openTemplateSettings,
  anlCloseModal, anlSaveCase, anlDeleteCase,
  anlOnTypeChange, anlOnAdvocateChange, anlOnStatusChange,
  anlAddPrev, anlRemovePrev, anlDocReceived, anlRemoveDoc, anlAddDoc,
  anlLinkSearch, anlSelectLinked, anlRemoveLinked,
  anlTplTab, anlTplAddDoc, anlTplRemove, anlTplSave,
  // Phase 2 — viewer-editable documents + timeline + notes (write-retry wrapped).
  toggleCaseDoc, anlAddTimelineEntry, anlDeleteTimelineEntry, anlTlSelChange,
  anlAddNote, anlEditNote, anlDeleteNote, anlSaveBaptismField, anlToggleBaptismAffidavit,
  expandCase,
});
