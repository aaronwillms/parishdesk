import { sb, withWriteRetry, serializeWrite } from '../supabase.js';
import { notifyUsers } from '../notifications.js';
import { store } from '../store.js';
import { fmtDate, todayCST, logActivity, reportWriteError } from '../utils.js';
import { isAdmin, canAccessSacrament, isSacramentCoordinator } from '../roles.js';
import { normalizePhone } from '../utils/phone.js';
import { buildPreparerField, readPreparerValue } from '../sacramental/preparerField.js';
import { renderSacramentalPanel, refreshActivePanel, openSacramentalRecord } from '../sacramental/panelShell.js';

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

const CEREMONY_TYPES = ['Catholic Church', 'Civil Ceremony', 'Non-Catholic Religious Ceremony', 'Other'];
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
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

const CLERGY_TYPES = ['pastor', 'parochial-vicar', 'priest-in-residence', 'deacon', 'religious'];
const CLERGY_TITLE_RE = /^(fr\.|rev\.|deacon|msgr\.|bishop|archbishop|cardinal)/i;

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
let _anlCoordinatorNames = [];   // annulment coordinator display names (preparer source)

// ── Access helpers ───────────────────────────────────────────────────────────
function fullAccess()  { return isAdmin() || canAccessSacrament('annulments'); }
function advocateIds()  { return store.currentUserRoles?.advocateCaseIds || []; }
function advocateOnly() { return !fullAccess() && advocateIds().length > 0; }

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
    name: d.name, received: d.received ?? d.done ?? false, deletable: d.deletable ?? true,
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

// Person-Responsible-for-Formation source — the annulment program's coordinator
// display names (the shared preparer field merges these with parish clergy + Other).
async function loadAnnulmentCoordinator() {
  try {
    const { data } = await sb.from('program_coordinators').select('coordinator_ids').eq('program', 'annulments').maybeSingle();
    _anlCoordinatorNames = (data?.coordinator_ids || []).map(pid => (store.personnel || []).find(p => p.id === pid)?.name).filter(Boolean);
  } catch (_) { _anlCoordinatorNames = []; }
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
  renderAnnulmentAlerts();
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
    <div id="annulments-alerts"></div>
    <div id="annulments-shell"></div>`;
  renderAnnulmentAlerts();
  const { annulmentConfig } = await import('../sacramental/annulmentConfig.js');
  renderSacramentalPanel(document.getElementById('annulments-shell'), annulmentConfig);
}

// ── Shell accessors (consumed by annulmentConfig) ───────────────────────────
export function getCaseRecords() { return allCases; }
export function getCaseRecord(id) { return allCases.find(x => x.id === id) || null; }
export { fullAccess as anlCanManage };   // CASE_STATUS / TYPE_BADGE already exported above
export { caseType, petName, respName, petLast, respLast, advocateName, caseDocs, caseTimeline };

// ── Priority Actions banner ──────────────────────────────────────────────────
// Missing documents for PREPARING cases only. Every non-Preparing status (In
// Tribunal / Judgement / Inactive) and every archived case is excluded — only
// active prep work surfaces here. Steps are not a concept for annulments; this is
// documents-only. One line per case: "PetLast vs RespLast: doc, doc, …" (maiden
// overrides last, matching the card title).
function _caseTitle(c) { return `${petLast(c) || '—'} vs ${respLast(c) || '—'}`; }
export function annulmentAlertItems(c) {
  if (c.archived || (c.status_code || 'prep') !== 'prep') return [];
  return caseDocs(c).filter(d => !d.received).map(d => d.name);
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
  const docs = caseDocs(c).map(d => ({ name: d.name, received: d.received, deletable: d.deletable }));
  if (!docs[i]) return;
  docs[i].received = !docs[i].received;
  if (await _anlPatch(caseId, { documents: docs })) { refreshActivePanel(); renderAnnulmentAlerts(); }
}

// Inline petitioner-baptism-location edit from the viewer (shown when the baptism
// document is unchecked). field = church|city|state|country → petitioner_baptism_*.
// Routes through the write-retry wrapper; NO full re-render, so focus/tabbing across
// the four fields is preserved. After each save we live-sync the baptism checkbox's
// locked state in place (enables it once all four fields are filled).
const BAPTISM_LOCK_TIP = 'Enter the church name, city, and state before marking the baptism record received.';
async function anlSaveBaptismField(caseId, field, el) {
  const cols = { church: 'petitioner_baptism_church', city: 'petitioner_baptism_city', state: 'petitioner_baptism_state', country: 'petitioner_baptism_country' };
  const col = cols[field]; if (!col) return;
  await _anlPatch(caseId, { [col]: (el?.value || '').trim() || null });
  _anlSyncBaptismLock(caseId);
}
// Enable/disable the baptism checkbox in place as the four fields are filled/cleared,
// without re-rendering (which would drop input focus mid-edit). Forward-only — only
// relevant while the doc is unchecked (the editable block, hence the box id, exists).
function _anlSyncBaptismLock(caseId) {
  const c = allCases.find(x => x.id === caseId); if (!c) return;
  const box = document.getElementById(`anl-bdoc-box-${caseId}`); if (!box) return;
  const docs = caseDocs(c);
  const idx = docs.findIndex(d => /baptism/i.test(d.name) && !/respondent/i.test(d.name));
  if (idx < 0) return;
  const filled = ['petitioner_baptism_church', 'petitioner_baptism_city', 'petitioner_baptism_state', 'petitioner_baptism_country']
    .every(k => String(c[k] || '').trim());
  if (filled) {
    box.setAttribute('onclick', `toggleCaseDoc('${caseId}',${idx})`);
    box.style.cursor = 'pointer'; box.style.opacity = '1'; box.removeAttribute('title');
  } else {
    box.removeAttribute('onclick');
    box.style.cursor = 'not-allowed'; box.style.opacity = '0.45'; box.setAttribute('title', BAPTISM_LOCK_TIP);
  }
  const note = document.getElementById(`anl-bdoc-note-${caseId}`);
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
  if (await _anlPatch(caseId, { timeline: tl })) refreshActivePanel();
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
function _normNote(n) { return { text: n.text || n.note || '', created_at: n.created_at || null, created_by: n.created_by || null }; }
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
  const list = parseCaseNotes(c);
  list.push({ text, created_at: nowIso(), created_by: _curUserId() });
  if (await _anlPatch(caseId, { notes: JSON.stringify(list) })) refreshActivePanel();
}
async function anlDeleteNote(caseId, idx) {
  const c = allCases.find(x => x.id === caseId); if (!c) return;
  const list = parseCaseNotes(c);
  if (idx < 0 || idx >= list.length) return;
  list.splice(idx, 1);
  if (await _anlPatch(caseId, { notes: list.length ? JSON.stringify(list) : null })) refreshActivePanel();
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

function _coupleLabel(id) { const r = (store.allCouples || []).find(x => x.id === id); return r ? `${r.groom || ''} & ${r.bride || ''}`.trim() : 'Marriage record'; }
function _ociaLabel(id)   { const r = (store.allOcia || []).find(x => x.id === id); return r ? (r.name || 'OCIA record') : 'OCIA record'; }

function clergyPersonnel() {
  return (store.personnel || []).filter(p => CLERGY_TYPES.includes(p.type) || (p.title && CLERGY_TITLE_RE.test(p.title)))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function _row(...cells) { return `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cells.map(c => `<div style="flex:1;min-width:120px;">${c}</div>`).join('')}</div>`; }
function _input(id, label, val = '', type = 'text') { return `<label>${label}</label><input type="${type}" id="${id}" value="${_esc(val)}" />`; }
function _stateSelect(id, val) { return `<label>State</label><select id="${id}"><option value="">—</option>${US_STATES.map(s => `<option${s === val ? ' selected' : ''}>${s}</option>`).join('')}</select>`; }
function _toggle(id, label, on, onchange = '') { return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:.75rem;"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${onchange ? `onchange="${onchange}"` : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" />${label}</label>`; }
function _sectionHead(t) { return `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--cardinal);margin:1.4rem 0 .5rem;border-bottom:.5px solid var(--stone);padding-bottom:4px;">${t}</div>`; }

function buildCaseModalHtml(c, opts = {}) {
  const inline = !!opts.inline;
  const isEdit = _M.isEdit;
  const sec = typeSections(_M.type);
  const advOpts = clergyPersonnel().map(p => `<option value="${p.id}"${c?.advocate_id === p.id ? ' selected' : ''}>${_esc(p.name)}</option>`).join('');

  let h = inline ? '' : `<div class="modal-title">${isEdit ? 'Edit Annulment Case' : 'New Annulment Case'}</div>`;

  // Section 1 — Type. The selected type drives which sections surface (see
  // typeSections / anlOnTypeChange) and seeds the document checklist.
  h += `<label>Annulment Type</label>
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

  // Person Responsible for Formation — shared Clergy + Coordinator + Other helper.
  // Stored in the `preparer` string column (consolidation standard).
  h += buildPreparerField('am-preparer', c?.preparer || '', { coordinatorNames: _anlCoordinatorNames, label: 'Person Responsible for Formation' });

  // Section 3 — Petitioner
  h += _sectionHead('Petitioner');
  h += _row(_input('am-pet-first', 'First Name', c?.petitioner_first || ''), _input('am-pet-middle', 'Middle', c?.petitioner_middle || ''), _input('am-pet-last', 'Last Name', c?.petitioner_last || ''), _input('am-pet-maiden', 'Maiden', c?.petitioner_maiden || ''));
  h += _input('am-pet-street', 'Street Address', c?.petitioner_street || '');
  h += _row(_input('am-pet-city', 'City', c?.petitioner_city || ''), _stateSelect('am-pet-state', c?.petitioner_state || ''), _input('am-pet-zip', 'ZIP', c?.petitioner_zip || ''));
  h += _row(_input('am-pet-cell', 'Cell Phone', c?.petitioner_cell || c?.contact_phone || '', 'tel'), _input('am-pet-email', 'Email', c?.petitioner_email || c?.contact_email || ''));
  h += _input('am-pet-dob', 'Date of Birth', c?.petitioner_dob && /^\d{4}-\d{2}-\d{2}/.test(c.petitioner_dob) ? c.petitioner_dob.slice(0, 10) : '', 'date');
  // Petitioner baptism location — PLAIN, always-editable fields (not type-gated):
  // Church, City, State, Country (Country defaulted). Always part of the petitioner
  // section; the doc-state-dependent behavior lives only in the viewer.
  h += _row(_input('am-pet-bchurch', 'Church of Baptism', c?.petitioner_baptism_church || ''), _input('am-pet-bcity', 'Baptism City', c?.petitioner_baptism_city || ''), _stateSelect('am-pet-bstate', c?.petitioner_baptism_state || ''), `<label>Country</label><select id="am-pet-bcountry">${COUNTRIES.map(co => `<option${(c?.petitioner_baptism_country || 'United States of America') === co ? ' selected' : ''}>${co}</option>`).join('')}</select>`);

  // Section 4 — Respondent
  h += _sectionHead('Respondent');
  h += _row(_input('am-resp-first', 'First Name', c?.respondent_first || ''), _input('am-resp-middle', 'Middle', c?.respondent_middle || ''), _input('am-resp-last', 'Last Name', c?.respondent_last || ''), _input('am-resp-maiden', 'Maiden', c?.respondent_maiden || ''));
  // Respondent baptismal-status toggles share the type-conditional baptism gate.
  h += `<div id="am-resp-status-wrap" style="display:${sec.baptism ? 'block' : 'none'};">`;
  h += _toggle('am-resp-baptized', 'Baptized?', !!c?.respondent_baptized);
  h += _toggle('am-resp-catholic', 'Catholic?', !!c?.respondent_catholic);
  h += `</div>`;

  // Section 5 — Marriage
  h += _sectionHead('Marriage Information');
  h += _row(_input('am-mar-date', 'Date of Marriage', c?.marriage_date || '', 'date'), _input('am-mar-city', 'City of Marriage', c?.marriage_city || ''));
  h += _row(_input('am-mar-state', 'State / Country', c?.marriage_state_country || ''),
    `<label>Ceremony Type</label><select id="am-mar-ceremony"><option value="">—</option>${CEREMONY_TYPES.map(t => `<option${c?.marriage_ceremony_type === t ? ' selected' : ''}>${t}</option>`).join('')}</select>`);
  h += _input('am-mar-church', 'Parish / Church where married (optional)', c?.marriage_church || '');

  // Section 6 — Tribunal
  h += _sectionHead('Tribunal');
  h += _row(_input('am-trib-diocese', 'Filed with the Diocese of', c?.tribunal_diocese || ''), _input('am-trib-filed', 'Date Filed', c?.date_filed || '', 'date'));

  // Section 7 — Previous annulments
  h += _sectionHead('Previous Annulments');
  h += _toggle('am-prev-toggle', 'Previous Annulment?', _M.prev.length > 0, 'anlOnPrevToggle()');
  h += `<div id="am-prev-wrap" style="display:${_M.prev.length > 0 ? 'block' : 'none'};margin-top:.5rem;"></div>`;

  // Section 8 — Briefer (formal only). briefer_process is a boolean ON a Formal
  // case (not a separate type). When on, the respondent joins as co-petitioner, so
  // the co_petitioner field is surfaced.
  h += `<div id="am-briefer-section" style="display:${_M.type === 'formal' ? 'block' : 'none'};">`;
  h += _sectionHead('Briefer Process');
  h += _toggle('am-briefer', 'Briefer Process', !!c?.briefer_process, 'anlOnBrieferToggle()');
  h += `<div id="am-briefer-info" style="display:${c?.briefer_process ? 'block' : 'none'};" class="anl-info-box">⚠️ The Briefer Process (Processus Brevior) requires:<br>• Both parties must jointly sign the petition<br>• The case is decided by the Bishop, not a collegiate tribunal<br>• Grounds must be evident from the facts</div>`;
  h += `<div id="am-copet-wrap" style="display:${c?.briefer_process ? 'block' : 'none'};">${_input('am-copetitioner', 'Co-petitioner (the respondent joins the petition)', c?.co_petitioner || '')}</div>`;
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

    h += _sectionHead('Linked Records');
    h += `<label>Marriage Prep record</label>
      <div style="position:relative;"><input type="text" id="am-link-mar" placeholder="Search couples by name…" oninput="anlLinkSearch('marriage')" autocomplete="off" style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
      <div id="am-link-mar-results" class="anl-link-results" style="display:none;"></div></div>
      <div id="am-link-mar-chip" style="margin-top:6px;"></div>`;
    h += `<label style="margin-top:.75rem;">OCIA record</label>
      <div style="position:relative;"><input type="text" id="am-link-ocia" placeholder="Search OCIA by name…" oninput="anlLinkSearch('ocia')" autocomplete="off" style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
      <div id="am-link-ocia-results" class="anl-link-results" style="display:none;"></div></div>
      <div id="am-link-ocia-chip" style="margin-top:6px;"></div>`;
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
  renderModalDocs(); renderModalPrev();
  if (_M.isEdit) { renderLinkedChip('marriage'); renderLinkedChip('ocia'); }
}

function renderModalDocs() {
  const el = document.getElementById('am-docs'); if (!el) return;
  el.innerHTML = _M.docs.map((d, i) => `
    <div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
      <input type="checkbox" ${d.received ? 'checked' : ''} onchange="anlDocReceived(${i},this.checked)" style="width:15px;height:15px;accent-color:var(--cardinal);" />
      <span style="flex:1;font-size:13px;color:var(--navy);">${_esc(d.name)}</span>
      ${d.deletable ? `<button onclick="anlRemoveDoc(${i})" title="Remove" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>` : `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required"></i>`}
    </div>`).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No documents.</div>`;
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
  // Respondent baptismal-status toggles remain type-conditional. (Petitioner baptism
  // location fields are now always shown — they are plain petitioner-section fields.)
  const sec = typeSections(val);
  const respS = document.getElementById('am-resp-status-wrap'); if (respS) respS.style.display = sec.baptism ? 'block' : 'none';
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
  boxes.forEach((b, i) => { if (_M.docs[i]) _M.docs[i].received = b.checked; });
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
  const cp = document.getElementById('am-copet-wrap'); if (cp) cp.style.display = on ? 'block' : 'none';
};
window.anlOnVetitumToggle = () => { const on = document.getElementById('am-vetitum').checked; document.getElementById('am-vetitum-notes-wrap').style.display = on ? 'block' : 'none'; };
window.anlOnPrevToggle = () => {
  const on = document.getElementById('am-prev-toggle').checked;
  document.getElementById('am-prev-wrap').style.display = on ? 'block' : 'none';
  if (on && !_M.prev.length) { _M.prev = [{ spouse_name: '', diocese: '' }]; renderModalPrev(); }
};
function anlAddPrev() { _syncPrevFromDom(); _M.prev.push({ spouse_name: '', diocese: '' }); renderModalPrev(); }
function anlRemovePrev(i) { _syncPrevFromDom(); _M.prev.splice(i, 1); renderModalPrev(); }
function anlDocReceived(i, v) { _M.docs[i].received = v; }
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
  const payload = {
    annulment_type: type,
    briefer_process: type === 'formal' ? _chk('am-briefer') : false,
    // Co-petitioner only applies to a Briefer (Formal) case; cleared otherwise.
    co_petitioner: (type === 'formal' && _chk('am-briefer')) ? (_v('am-copetitioner') || null) : null,
    advocate_id: advSel && advSel !== '__other' ? advSel : null,
    advocate_name_override: advSel === '__other' ? (_v('am-advocate-other') || null) : null,
    // Person Responsible for Formation — shared helper stores a display-name string
    // in `preparer` (consistent with every other sacrament panel post-consolidation).
    preparer: readPreparerValue('am-preparer'),
    petitioner_first: _v('am-pet-first') || null, petitioner_middle: _v('am-pet-middle') || null,
    petitioner_last: _v('am-pet-last') || null, petitioner_maiden: _v('am-pet-maiden') || null,
    petitioner_street: _v('am-pet-street') || null, petitioner_city: _v('am-pet-city') || null,
    petitioner_state: _v('am-pet-state') || null, petitioner_zip: _v('am-pet-zip') || null,
    petitioner_cell: normalizePhone(_v('am-pet-cell')) || null, petitioner_email: _v('am-pet-email') || null,
    petitioner_dob: _v('am-pet-dob') || null,
    petitioner_baptism_church: _v('am-pet-bchurch') || null, petitioner_baptism_city: _v('am-pet-bcity') || null, petitioner_baptism_state: _v('am-pet-bstate') || null, petitioner_baptism_country: _v('am-pet-bcountry') || null,
    respondent_first: _v('am-resp-first') || null, respondent_middle: _v('am-resp-middle') || null,
    respondent_last: _v('am-resp-last') || null, respondent_maiden: _v('am-resp-maiden') || null,
    respondent_baptized: _chk('am-resp-baptized'), respondent_catholic: _chk('am-resp-catholic'),
    marriage_date: _v('am-mar-date') || null, marriage_city: _v('am-mar-city') || null,
    marriage_state_country: _v('am-mar-state') || null, marriage_ceremony_type: _v('am-mar-ceremony') || null,
    marriage_church: _v('am-mar-church') || null,
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
  payload.linked_marriage_prep_id = _M.linkedMarriage?.id || null;
  payload.linked_ocia_id = _M.linkedOcia?.id || null;

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
    if (res.ok) { anlCloseModal(); refreshActivePanel(); }
    return;
  }
  payload.status_code = 'prep';
  payload.judgement_finalized = null;
  payload.archived = false;
  payload.timeline = [{ type: 'auto', text: 'Case Opened', created_at: nowIso(), created_by: _curUserId() }];
  const { error } = await withWriteRetry(() => sb.from('annulment_cases').insert(payload), { kind: 'insert' });
  if (error) { reportWriteError('annulment insert', error); return; }
  await logActivity({ action: 'opened annulment case', entityType: 'annulments', entityName: payload.petitioner || 'New case', contextType: 'annulments' });
  anlCloseModal(); await loadCasesData(); refreshActivePanel();
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
  const { error } = await withWriteRetry(() => sb.from('annulment_cases').update(payload).eq('id', id), { kind: 'update' });
  if (error) { reportWriteError('annulment update', error); return { ok: false }; }
  if (prior) Object.assign(prior, payload);
  await logActivity({ action: 'updated annulment case', entityType: 'annulments', entityName: payload.petitioner || 'Case', contextType: 'annulments', contextId: id });
  if (statusChanged && prior) await notifyStatusChange(prior, newStatus);
  await loadCasesData();
  return { ok: true };
}

export async function anlDeleteRec(id) {
  if (!confirm('Permanently delete this case? This cannot be undone.')) return { ok: false };
  const { error } = await sb.from('annulment_cases').delete().eq('id', id);
  if (error) { reportWriteError('annulment delete', error); return { ok: false }; }
  allCases = allCases.filter(x => x.id !== id);
  store.allCases = allCases;
  await logActivity({ action: 'deleted annulment case', entityType: 'annulments', entityName: id, contextType: 'annulments' });
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
  const btn = document.querySelector('#anl-overlay .modal-actions .btn-primary');
  if (btn) { btn.textContent = 'Saved ✓'; btn.style.background = '#2D6A4F'; setTimeout(() => { btn.textContent = 'Save Template'; btn.style.background = ''; }, 1600); }
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
  anlAddNote, anlDeleteNote, anlSaveBaptismField,
  expandCase,
});
