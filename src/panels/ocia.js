import { sb, withWriteRetry, serializeWrite, insertWithRetry, deleteWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, formatDateDisplay, todayCST, logActivity, reportWriteError, applyDocCheck, docCheckStampHtml } from '../utils.js';
import { expandCase, ensureCaseDisplays, getCaseDisplay } from './annulments.js';
import { isAdmin, canAccessSacrament, isSacramentCoordinator } from '../roles.js';
import { notifyUsers, getUserIdsForSacrament } from '../notifications.js';
import { formatPhone, normalizePhone } from '../utils/phone.js';
import { buildPreparerField, readPreparerValue } from '../sacramental/preparerField.js';
import { inheritCohortFormation, setFieldLocked,
  institutionAddressAutofill, institutionOptionsHtml, institutionSelectedName, institutionAddressSync } from '../sacramental/churchLocation.js';
import { registerCohortManager } from '../sacramental/cohortManager.js';
import { renderSacramentalPanel, refreshActivePanel, openSacramentalRecord } from '../sacramental/panelShell.js';

const OCIA_STATUS = {
  inquirer:    { label:'Inquirer',             color:'#4A1D96', bg:'#EDE9FE', dot:'#7C3AED' },
  preparation: { label:'In Preparation',       color:'#7D6608', bg:'#FEF9E7', dot:'#D4AC0D' },
  complete:    { label:'Preparation Complete', color:'#2D6A4F', bg:'#D8F3DC', dot:'#2D6A4F' },
  received:    { label:'Received',              color:'#1B4F72', bg:'#D6EAF8', dot:'#1B4F72' },
  inactive:    { label:'Inactive',             color:'#616A6B', bg:'#F2F3F4', dot:'#AAB7B8' },
};
const HOW_ENDED = ['Death', 'Annulment', 'Civil Divorce Only'];
const COUNTRIES = ['United States of America', 'Mexico', 'Philippines', 'Vietnam', 'Nigeria', 'India', 'Other'];
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
const CLERGY_TYPES = ['pastor', 'parochial-vicar', 'priest-in-residence', 'deacon', 'religious'];
const FALLBACK_TEMPLATES = { catechumen: [], candidate: [{ name: 'Baptismal Certificate', deletable: false }] };

let allOcia = [], ociaFilter = 'all', ociaExpanded = null;
let _templates = {}, _M = null, _ociaCoordinatorNames = [], _cohorts = [];

// ── Cohort mechanism (mirrors Confirmation: sacramental_cohorts, panel='ocia') ──
function cohortLabel(dateStr) { if (!dateStr) return 'No date'; const d = new Date(dateStr + 'T00:00:00'); return isNaN(d) ? 'No date' : d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }
async function loadCohorts() {
  const { data } = await sb.from('sacramental_cohorts').select('*').eq('panel', 'ocia').order('cohort_date', { ascending: false });
  _cohorts = data || [];
}
export function cohortKeyOf(p) { return p?.cohort_id || null; }
export function ociaCohortName(id) { if (!id) return 'No Cohort'; return cohortLabel(_cohorts.find(c => c.id === id)?.cohort_date); }
export function ociaCohortDateOf(id) { return _cohorts.find(c => c.id === id)?.cohort_date || ''; }

// Formation coordinator display names for the "Person Responsible for Formation"
// dropdown (Clergy + coordinator(s) + Other), mirroring the other sacrament panels.
async function loadOciaCoordinator() {
  try {
    const { data } = await sb.from('program_coordinators').select('coordinator_ids').eq('program', 'ocia').maybeSingle();
    _ociaCoordinatorNames = (data?.coordinator_ids || []).map(pid => (store.personnel || []).find(p => p.id === pid)?.name).filter(Boolean);
  } catch (_) { _ociaCoordinatorNames = []; }
}

function fullAccess() { return isAdmin() || canAccessSacrament('ocia'); }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _curUserName() { return store.currentUserProfile?.personnel?.name || 'Staff'; }
function nowIso() { return new Date().toISOString(); }
// Parish clergy — source of truth is the parish-wide personnel.clergy boolean (set
// in the Directory), the same source clergyNames() uses. The old filter relied on
// personnel.type / personnel.title, but title was retired in the HR Stage 1
// collapse and clergy are commonly type:'staff', so it returned nobody. (Same fix
// applied to Baptism in 4a.) CLERGY_TYPES kept as a fallback.
function clergyPersonnel() { return (store.personnel || []).filter(p => p.clergy || CLERGY_TYPES.includes(p.type)).sort((a, b) => (a.name || '').localeCompare(b.name || '')); }

// Easter (Anonymous Gregorian algorithm)
function easterDate(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}
function nextEaster() {
  const today = new Date(new Date().toLocaleString('en-US', { timeZone: store.parishSettings?.timezone || 'America/Chicago' }));
  const e = easterDate(today.getFullYear());
  return today <= e ? e : easterDate(today.getFullYear() + 1);
}
function ociaAge(dob) {
  if (!dob) return null;
  const d = new Date(dob); if (isNaN(d)) return null;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: store.parishSettings?.timezone || 'America/Chicago' }));
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

// ── Field accessors (backward-compatible) ────────────────────────────────────
function candType(p) { return p.candidate_type || (p.baptismal_status === 'baptized' ? 'candidate' : 'catechumen'); }
function lastNameOf(p) { const parts = (p.name || '').trim().split(/\s+/); return parts[parts.length - 1] || ''; }
function caseIsConfirmed(caseId) { if (!caseId) return false; const c = getCaseDisplay(caseId); return !!(c && c.status_code === 'affirm' && c.judgement_finalized === 'yes'); }
// ── Prior-marriage entry model ──────────────────────────────────────────────
// Entry shape: { first, middle, last, maiden, how_ended, annulment_case_id, prior_party }.
//   • Names: manual when no case is linked; autofilled from the linked annulment
//     case's NON-OCIA party (and greyed) when linked.
//   • how_ended: STORED only when unlinked. When a case is linked it is DERIVED at
//     read time from the case status (single source of truth) — never stored, so a
//     case advancing from in-progress to affirmed flips it automatically.
//   • prior_party: which case party ('petitioner'|'respondent') is the prior spouse
//     (set by party detection, or by the user when detection is ambiguous).
// Legacy entries carried a single `spouse_name` string — normPrior() parses it.

// Parse a single display name "First Middle Last (Maiden)" → structured parts.
function parseSpouseName(s) {
  s = String(s == null ? '' : s).trim();
  let maiden = '';
  const mm = s.match(/\(([^)]+)\)\s*$/);           // trailing "(Maiden)"
  if (mm) { maiden = mm[1].trim(); s = s.slice(0, mm.index).trim(); }
  const parts = s.split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', middle: '', last: '', maiden };
  if (parts.length === 1) return { first: parts[0], middle: '', last: '', maiden };
  if (parts.length === 2) return { first: parts[0], middle: '', last: parts[1], maiden };
  return { first: parts[0], middle: parts.slice(1, -1).join(' '), last: parts[parts.length - 1], maiden };
}
// Normalize any stored entry (new OR legacy single-name) to the new shape.
function normPrior(m) {
  m = m || {};
  const base = (m.first || m.middle || m.last || m.maiden)
    ? { first: m.first || '', middle: m.middle || '', last: m.last || '', maiden: m.maiden || '' }
    : parseSpouseName(m.spouse_name || m.ex_name || '');
  return { ...base, how_ended: m.how_ended || 'Civil Divorce Only', annulment_case_id: m.annulment_case_id || null, prior_party: m.prior_party || null };
}
// DERIVE "how ended" at read time: a linked case in progress → "Civil Divorce Only";
// affirmative + finalized → "Annulment". Unlinked → the stored manual value.
export function pmHowEnded(m) {
  if (m && m.annulment_case_id) return caseIsConfirmed(m.annulment_case_id) ? 'Annulment' : 'Civil Divorce Only';
  return (m && m.how_ended) || '';
}
// Display name for the prior spouse (structured, with legacy fallback).
export function pmDisplayName(m) {
  if (!m) return '';
  const full = [m.first, m.middle, m.last].filter(Boolean).join(' ') || m.spouse_name || '';
  return m.maiden ? `${full} (${m.maiden})`.trim() : full;
}
function pmResolved(m) {
  const he = pmHowEnded(m);
  if (he === 'Death') return true;
  if (he === 'Annulment') return true;
  return false;   // Civil Divorce Only (linked-in-progress or unlinked) → unresolved
}

// ── Party detection ─────────────────────────────────────────────────────────
// Decide which annulment-case party is the PRIOR SPOUSE, given the OCIA person's
// name. The OCIA person is whichever party they match; the spouse is the OTHER.
// Scoring (normalized, parentheticals/punctuation stripped): exact full name = 3,
// first+last = 2, last-only = 1. A party is "the OCIA person" only when it scores
// ≥2 AND strictly beats the other party → confident; the spouse is then the
// opposite party. Anything else (tie / both / neither match) → NOT confident, so
// the caller falls back to letting the user pick. NEVER autofills the discerner's
// own name as their prior spouse.
function _normName(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function _matchScore(meNorm, otherNorm) {
  if (!meNorm || !otherNorm) return 0;
  if (meNorm === otherNorm) return 3;
  const me = meNorm.split(' '), ot = otherNorm.split(' ');
  const meFirst = me[0], meLast = me[me.length - 1], oFirst = ot[0], oLast = ot[ot.length - 1];
  if (oFirst === meFirst && oLast === meLast) return 2;
  if (oLast === meLast) return 1;
  return 0;
}
function detectPriorSpouseParty(caseDisp, ociaFullName) {
  const me = _normName(ociaFullName);
  if (!me || !caseDisp) return { party: null, confident: false };
  const sp = _matchScore(me, _normName(caseDisp.petitioner));
  const sr = _matchScore(me, _normName(caseDisp.respondent));
  if (sp >= 2 && sp > sr) return { party: 'respondent', confident: true };  // OCIA = petitioner → spouse = respondent
  if (sr >= 2 && sr > sp) return { party: 'petitioner', confident: true };  // OCIA = respondent → spouse = petitioner
  return { party: null, confident: false };                                 // ambiguous → user picks
}
function _partyName(caseDisp, party) {
  if (!caseDisp || !party) return '';
  return party === 'petitioner' ? (caseDisp.petitioner || '') : (caseDisp.respondent || '');
}
// The OCIA person's current full name (from the open modal's name inputs).
function currentOciaName() { return [_v('of-first'), _v('of-middle'), _v('of-last')].filter(Boolean).join(' '); }
// Map an in-memory entry to its stored jsonb shape. how_ended is stored ONLY when
// unlinked (null when linked → derived at read time, never store the flip).
function _priorToStore(m) {
  const linked = !!m.annulment_case_id;
  return {
    first: m.first || '', middle: m.middle || '', last: m.last || '', maiden: m.maiden || '',
    how_ended: linked ? null : (m.how_ended || 'Civil Divorce Only'),
    annulment_case_id: m.annulment_case_id || null,
    prior_party: linked ? (m.prior_party || null) : null,
  };
}
function isMinor(p) { const a = ociaAge(p.dob); return a !== null && a < 18; }
function hasConsent(p) { return !!p.parental_consent; }
function normDocs(p) { return (p.documents || []).map(d => ({ name: d.name, received: d.received ?? d.done ?? false, deletable: d.deletable ?? !d.auto, auto: !!d.auto, checked_on: d.checked_on || null })); }
function notesOf(p) {
  const out = (Array.isArray(p.notes_log) ? p.notes_log : []).map(n => ({ note: n.note || '', by: n.by || null, created_at: n.created_at || null }));
  if (p.notes && String(p.notes).trim()) out.push({ note: String(p.notes).trim(), by: null, created_at: null, legacy: true });
  return out;
}
function receptionChip(p) {
  if (!['preparation', 'complete', 'received'].includes(p.status_code)) return null;
  if (!p.reception_date) return null;
  const yr = new Date(p.reception_date + 'T00:00:00').getFullYear();
  const easter = (p.reception_is_easter_vigil !== false) || p.reception_date_type === 'easter';
  return easter ? `Easter ${yr}` : formatDateDisplay(p.reception_date);
}

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadTemplates() {
  const { data, error } = await sb.from('ocia_templates').select('candidate_type, documents');
  _templates = {};
  if (!error && data) data.forEach(r => { _templates[r.candidate_type] = r.documents || []; });
  ['catechumen', 'candidate'].forEach(k => { if (!_templates[k]) _templates[k] = JSON.parse(JSON.stringify(FALLBACK_TEMPLATES[k])); });
}
// Data-only refresh (used by the shell + autosave/modal). Returns the record list.
export async function loadOciaData() {
  await Promise.all([loadTemplates(), loadOciaCoordinator(), loadCohorts()]);
  const { data, error } = await sb.from('sacramental_ocia').select('*').order('created_at', { ascending: false });
  if (error) { console.error('[ocia]', error); return []; }
  allOcia = data || [];
  store.allOcia = allOcia;
  // Warm the annulment display cache for every linked prior-marriage case so chips
  // and the "resolved" flag resolve by id without the Annulments panel being loaded.
  await ensureCaseDisplays(allOcia.flatMap(p => (p.prior_marriages || []).map(m => m.annulment_case_id)));
  updateOciaStats();
  renderOciaAlerts();
  return allOcia;
}
// Nav loader — fetch then mount the master-detail shell into #ocia-root.
export async function loadOcia() {
  await loadOciaData();
  const root = document.getElementById('ocia-root');
  if (!root) return;
  const { ociaConfig } = await import('../sacramental/ociaConfig.js');
  renderSacramentalPanel(root, ociaConfig);
}

// ── Shell accessors (consumed by ociaConfig) ────────────────────────────────
export function getOciaRecords() { return allOcia; }
export function getOciaRecord(id) { return allOcia.find(x => x.id === id) || null; }
export { fullAccess as ociaCanManage, OCIA_STATUS, ociaAge };
export function ociaName(p) { return p?.name || '—'; }
export function ociaLastName(p) { return lastNameOf(p); }
export function ociaStatusOf(p) { return p?.status_code || 'inquirer'; }
export function candTypeOf(p) { return candType(p); }
export function ociaNotesOf(p) { return notesOf(p); }
export function ociaIsMinor(p) { return isMinor(p); }
// "Annulment Needed" flag: any prior marriage ended by "Civil Divorce Only" (civil
// divorce but no Church annulment/dissolution) with NO annulment case linked to it.
// The per-prior-marriage `annulment_case_id` IS the OCIA→annulment link (there is no
// file-level linked_annulment_id column); linking an annulment to that prior marriage
// resolves the impediment, so the flag clears.
export function ociaNeedsAnnulment(p) {
  return (p?.prior_marriages || []).some(m => m.how_ended === 'Civil Divorce Only' && !m.annulment_case_id);
}

// ── Viewer-editable autosave (notes + minor permission) ─────────────────────
// Serialize per-record so rapid edits don't overlap; retry transport failures.
async function _ociaPatch(id, patch) {
  const p = allOcia.find(x => x.id === id); if (!p) return null;
  const { error } = await serializeWrite(`ocia:${id}`, () =>
    withWriteRetry(() => sb.from('sacramental_ocia').update({ ...patch, updated_at: nowIso() }).eq('id', id), { kind: 'update' }));
  if (error) { reportWriteError('ocia update', error); return null; }
  Object.assign(p, patch); return p;
}
// Notes (notes_log jsonb) — add/delete from the viewer, write-retry wrapped.
async function ociaAddNote(id) {
  const p = allOcia.find(x => x.id === id); if (!p) return;
  const inp = document.getElementById(`ocia-note-input-${id}`); const note = (inp?.value || '').trim();
  if (!note) return;
  const log = Array.isArray(p.notes_log) ? JSON.parse(JSON.stringify(p.notes_log)) : [];
  log.push({ note, by: _curUserName(), created_at: nowIso() });
  if (await _ociaPatch(id, { notes_log: log })) window.flashSavedThen(() => refreshActivePanel());
}
async function ociaDeleteNote(id, idx) {
  const p = allOcia.find(x => x.id === id); if (!p) return;
  const log = Array.isArray(p.notes_log) ? JSON.parse(JSON.stringify(p.notes_log)) : [];
  if (idx < 0 || idx >= log.length) return;
  log.splice(idx, 1);
  if (await _ociaPatch(id, { notes_log: log })) refreshActivePanel();
}

// ── Minor parent/guardian permission (viewer inline + lock-gate) ────────────
const PERM_LOCK_TIP = 'Enter the parent/guardian name and the date before marking permission granted.';
// Inline name/date edit (shown when permission not yet granted). No re-render, so
// focus/tab is preserved; re-sync the gate after each save.
async function ociaSavePermField(id, field, el) {
  const col = field === 'name' ? 'minor_guardian_name' : 'minor_permission_date';
  await _ociaPatch(id, { [col]: (el?.value || '').trim() || null });
  _ociaSyncPermLock(id);
}
// Toggle "permission granted" → mirror name/date into the consent_* columns and
// re-render so the section collapses to its read-only display.
async function ociaTogglePermission(id, checked) {
  const p = allOcia.find(x => x.id === id); if (!p) return;
  const patch = { parental_consent: !!checked };
  if (checked) { patch.consent_parent_name = p.minor_guardian_name || null; patch.consent_date = p.minor_permission_date || null; }
  if (await _ociaPatch(id, patch)) refreshActivePanel();
}
// Enable/disable the granted checkbox in place as name+date fill (forward-only).
function _ociaSyncPermLock(id) {
  const p = allOcia.find(x => x.id === id); if (!p) return;
  const box = document.getElementById(`ocia-perm-box-${id}`); if (!box) return;
  const filled = String(p.minor_guardian_name || '').trim() && String(p.minor_permission_date || '').trim();
  if (filled) {
    box.setAttribute('onclick', `ociaTogglePermission('${id}',true)`);
    box.style.cursor = 'pointer'; box.style.opacity = '1'; box.removeAttribute('title');
  } else {
    box.removeAttribute('onclick');
    box.style.cursor = 'not-allowed'; box.style.opacity = '0.45'; box.setAttribute('title', PERM_LOCK_TIP);
  }
  const note = document.getElementById(`ocia-perm-note-${id}`);
  if (note) note.style.display = filled ? 'none' : 'block';
}

// ── Priority Actions banner — minors missing permission; Civil-Divorce-Only prior
// marriages needing an annulment (same per-file item pattern). ────────────────────
export function ociaAlertItems(p) {
  if (p.archived) return [];
  const items = [];
  if (isMinor(p) && !p.parental_consent) items.push('Parent/Guardian Permission Needed');
  if (ociaNeedsAnnulment(p)) items.push('Annulment Needed');
  return items;
}
function renderOciaAlerts() {
  const el = document.getElementById('ocia-alerts'); if (!el) return;
  const blocks = allOcia.map(p => ({ p, items: ociaAlertItems(p) })).filter(b => b.items.length);
  if (!blocks.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="alert-strip" style="margin-bottom:1rem;flex-direction:column;align-items:flex-start;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><i class="ti ti-alert-triangle" style="color:var(--gold);font-size:15px;"></i><strong style="font-size:13px;">Priority actions</strong></div>
    ${blocks.map(b => `<div style="font-size:13px;color:var(--navy);margin-bottom:4px;"><strong>${_esc(b.p.name || '—')}</strong>: ${b.items.map(_esc).join(', ')}</div>`).join('')}
  </div>`;
}

function updateOciaStats() {
  const active = allOcia.filter(p => !p.archived && p.status_code !== 'inactive');
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('stat-ocia-total', active.length);
  set('stat-ocia-prep', active.filter(p => p.status_code === 'preparation' || p.status_code === 'complete').length);
  const yr = String(new Date().getFullYear());
  set('stat-ocia-received', allOcia.filter(p => p.status_code === 'received' && p.reception_date && String(p.reception_date).startsWith(yr)).length);
}

// Cross-link entry — open a specific OCIA record in the shell (deep-link).
export async function expandOcia(id) {
  openSacramentalRecord('ocia', id);   // set the hash first so the shell opens it on mount
  window.switchPanel('ocia');
}

// ── Big modal scaffolding ────────────────────────────────────────────────────
function _ociaOverlay() {
  let ov = document.getElementById('ocia-overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'ocia-overlay'; ov.className = 'modal-overlay'; ov.innerHTML = `<div class="modal anl-modal"><button class="modal-close" onclick="ociaCloseModal()">×</button><div id="ocia-modal-content"></div></div>`; document.body.appendChild(ov); ov.addEventListener('click', e => { if (e.target === ov) ociaCloseModal(); }); }
  return ov;
}
function _ociaOpen(html) { _ociaOverlay(); document.getElementById('ocia-modal-content').innerHTML = html; document.getElementById('ocia-overlay').classList.add('open'); }
function ociaCloseModal() { document.getElementById('ocia-overlay')?.classList.remove('open'); _M = null; }

function _row(...cells) { return `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cells.map(c => `<div style="flex:1;min-width:120px;">${c}</div>`).join('')}</div>`; }
function _input(id, label, val = '', type = 'text') { return `<label>${label}</label><input type="${type}" id="${id}" value="${_esc(val)}" />`; }
function _stateSelect(id, val) { return `<label>State/Province</label><select id="${id}"><option value="">—</option>${US_STATES.map(s => `<option${s === val ? ' selected' : ''}>${s}</option>`).join('')}</select>`; }
function _toggle(id, label, on, onchange = '') { return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:.75rem;"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${onchange ? `onchange="${onchange}"` : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" />${label}</label>`; }
function _sectionHead(t) { return `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--cardinal);margin:1.4rem 0 .5rem;border-bottom:.5px solid var(--stone);padding-bottom:4px;">${t}</div>`; }

// ── Create / Edit ────────────────────────────────────────────────────────────
async function openOciaCreate() {
  _M = newModalState(null, 'catechumen');
  _ociaOpen(buildModalHtml(null)); _hydrate();
}
function openOciaEdit(id) {
  const p = allOcia.find(x => x.id === id); if (!p) return;
  _M = newModalState(p, candType(p));
  _ociaOpen(buildModalHtml(p)); _hydrate();
}
function newModalState(p, type) {
  return {
    id: p?.id || null, isEdit: !!p, type,
    docs: p ? normDocs(p) : computeTemplateDocs(type),
    prior: (p?.prior_marriages || []).map(normPrior),
    family: p?.family_group_id ? { group_id: p.family_group_id, label: `${lastNameOf(p)} Family` } : null,
    recOther: p ? (p.reception_date && p.reception_is_easter_vigil === false) : false,
  };
}
function computeTemplateDocs(type) {
  const base = (_templates[type] || FALLBACK_TEMPLATES[type] || []).map(d => ({ name: d.name, received: false, deletable: d.deletable ?? true, auto: d.deletable === false }));
  if (type === 'candidate' && !base.some(d => /baptismal certificate/i.test(d.name))) base.unshift({ name: 'Baptismal Certificate', received: false, deletable: false, auto: true });
  return base;
}
function _ociaLabel(id) { const r = (store.allOcia || []).find(x => x.id === id); return r ? (r.name || 'OCIA') : 'OCIA'; }
// Resolve by id from the cross-panel display cache (DB-backed) so the chip label
// renders even if the Annulments panel was never opened (cache warmed on load).
function _caseLabel(id) { const r = getCaseDisplay(id); return r ? `${r.petitioner || ''}${r.respondent ? ' v. ' + r.respondent : ''}` : 'Annulment case'; }

function _nameParts(p) {
  const parts = (p?.name || '').trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] || '', middle: '', last: '' };
  if (parts.length === 2) return { first: parts[0], middle: '', last: parts[1] };
  return { first: parts[0], middle: parts.slice(1, -1).join(' '), last: parts[parts.length - 1] };
}

function buildModalHtml(p, opts = {}) {
  const inline = !!opts.inline;
  const isEdit = _M.isEdit;
  const np = _nameParts(p);
  const age = ociaAge(p?.dob);
  const instOpts = (store.institutions || []).map(i => `<option value="${i.name}"${p?.reception_church === i.name ? ' selected' : ''}>${_esc(i.name)}</option>`).join('');

  let h = inline ? '' : `<div class="modal-title">${isEdit ? 'Edit OCIA File' : 'New OCIA Candidate'}</div>`;

  // Section 1 — Cohort FIRST (SELECT an existing cohort; creation lives in Manage
  // Cohorts). Picking it first defaults BOTH the reception church and the formation
  // person (editable) — see ociaCohortPick.
  h += _sectionHead('Cohort');
  if (_cohorts.length) {
    const cohOpts = _cohorts.map(c => `<option value="${c.id}"${p?.cohort_id === c.id ? ' selected' : ''}>${cohortLabel(c.cohort_date)}</option>`).join('');
    h += `<label>Cohort</label><select id="of-cohort" onchange="ociaCohortPick(this.value)"><option value="">— None —</option>${cohOpts}</select>`;
  } else {
    h += `<label>Cohort</label><select id="of-cohort" disabled style="color:#9CA3AF;"><option value="">No cohorts yet</option></select>
      <div style="font-size:11.5px;color:#9CA3AF;margin-top:4px;">Create a cohort first via <strong>Manage Cohorts</strong>.</div>`;
  }

  // Person Responsible for Formation — shared Clergy + Coordinator + Other helper
  // (labeled "OCIA Prep" in the viewer). Stored in `preparer`.
  h += _sectionHead('Person Responsible for Formation');
  h += buildPreparerField('of-preparer', p?.preparer || '', { coordinatorNames: _ociaCoordinatorNames, label: 'Person Responsible for Formation' });

  // Status (shown in BOTH create + edit; defaults to Inquirer). The reception
  // sub-section + sacraments + archive remain edit-only below.
  h += _sectionHead('Status');
  h += `<label>Status</label><select id="of-status" onchange="ociaStatusChange(this.value)">${Object.entries(OCIA_STATUS).map(([k, v]) => `<option value="${k}"${(p?.status_code || 'inquirer') === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`;

  // Candidate Type toggle buttons
  h += _sectionHead('Candidate Type');
  h += `<div style="display:flex;gap:10px;">
    <button type="button" id="ot-catechumen" class="ocia-type-btn${_M.type === 'catechumen' ? ' active' : ''}" onclick="ociaSetType('catechumen')" style="flex:1;">Catechumen<br><span style="font-size:11px;font-weight:400;opacity:.8;">unbaptized</span></button>
    <button type="button" id="ot-candidate" class="ocia-type-btn${_M.type === 'candidate' ? ' active' : ''}" onclick="ociaSetType('candidate')" style="flex:1;">Candidate<br><span style="font-size:11px;font-weight:400;opacity:.8;">already baptized</span></button>
  </div>`;

  // Section 3 — Candidate info
  h += _sectionHead('Candidate Information');
  h += _row(_input('of-first', 'First Name', np.first), _input('of-middle', 'Middle', np.middle), _input('of-last', 'Last Name', np.last));
  h += _row(_input('of-phone', 'Cell Phone', p?.phone || '', 'tel'), _input('of-email', 'Email', p?.email || ''));
  h += `<label>Date of Birth</label><input type="date" id="of-dob" value="${(p?.dob && /^\d{4}-\d{2}-\d{2}/.test(p.dob)) ? p.dob.slice(0, 10) : ''}" oninput="ociaDobChange()" />`;
  h += `<div id="of-minor-wrap" style="display:${age !== null && age <= 17 ? 'block' : 'none'};">
    ${_toggle('of-consent', 'Parent/Guardian Permission Granted', !!p?.parental_consent)}
    ${_input('of-guardian', 'Parent/Guardian Name', p?.minor_guardian_name || p?.consent_parent_name || '')}
    ${_input('of-permdate', 'Date Permission Received', p?.minor_permission_date || p?.consent_date || '', 'date')}
  </div>`;

  // Section 4 — Baptism (candidate only)
  h += `<div id="of-baptism-section" style="display:${_M.type === 'candidate' ? 'block' : 'none'};">`;
  h += _sectionHead('Baptism Information');
  // Church of Baptism — institution dropdown + Other; a listed church autofills +
  // greys City/State (name round-trips via baptism_church).
  const obchName = p?.baptism_church || '';
  const obchOther = institutionOptionsHtml(obchName).isOther;
  h += `<label>Church of Baptism</label><select id="of-bchurch-sel" onchange="ociaBaptismChange(this.value)"><option value="">— Select —</option>${institutionOptionsHtml(obchName).options}<option value="__other"${obchOther ? ' selected' : ''}>Other…</option></select>`;
  h += `<div id="of-bchurch-other-wrap" style="display:${obchOther ? 'block' : 'none'};margin-top:6px;">${_input('of-bchurch-name', 'Church name', obchOther ? obchName : '')}</div>`;
  h += _row(_input('of-bcity', 'City', p?.baptism_city || p?.baptism_city_state || ''), _stateSelect('of-bstate', p?.baptism_state || ''));
  h += `<label>Country</label><select id="of-bcountry">${COUNTRIES.map(co => `<option${(p?.baptism_country || 'United States of America') === co ? ' selected' : ''}>${co}</option>`).join('')}</select>`;
  h += `</div>`;

  // Section 5 — Sponsor
  h += _sectionHead('Sponsor');
  h += _input('of-sponsor', 'Sponsor Name', p?.sponsor_name || p?.sponsor1 || '');

  // Section 6 — Prior marriages
  h += _sectionHead('Prior Marriages');
  h += _toggle('of-prior-toggle', 'Prior Marriage?', _M.prior.length > 0, 'ociaPriorToggle()');
  h += `<div id="of-prior-wrap" style="display:${_M.prior.length > 0 ? 'block' : 'none'};margin-top:.5rem;"></div>`;

  // Section 7 — Family group
  h += _sectionHead('Family Group');
  h += `<div style="position:relative;"><input type="text" id="of-family-search" placeholder="Link to family (search by last name)…" autocomplete="off" oninput="ociaFamilySearch()" style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
    <div id="of-family-results" class="anl-link-results" style="display:none;"></div></div>
    <div id="of-family-chip" style="margin-top:6px;"></div>`;

  // Section 8 — Documents
  h += _sectionHead('Document Checklist');
  h += `<div id="of-docs"></div><div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="of-doc-new" placeholder="Add document…" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();ociaAddDoc();}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="ociaAddDoc()">+ Add</button></div>`;

  // Edit-only
  if (isEdit) {
    h += _sectionHead('Reception');
    const showRec = p?.status_code === 'received' || p?.status_code === 'complete';
    const easter = nextEaster(); const easterVal = easter.toISOString().slice(0, 10);
    h += `<div id="of-rec-wrap" style="display:${showRec ? 'block' : 'none'};" data-easter="${easterVal}">
      ${_toggle('of-rec-other', 'Other date (not Easter Vigil)', _M.recOther, 'ociaRecOtherChange()')}
      <div id="of-rec-date-wrap" style="display:${_M.recOther ? 'block' : 'none'};">${_input('of-rec-date', 'Reception Date', (p?.reception_date && _M.recOther) ? p.reception_date : '', 'date')}</div>
      <div id="of-rec-easter-note" style="display:${_M.recOther ? 'none' : 'block'};font-size:12px;color:#7D6608;margin-top:6px;">Reception at the Easter Vigil — ${formatDateDisplay(easterVal)}</div>
      <label style="margin-top:.75rem;">Church of Reception</label><select id="of-rec-church"><option value="">— Select —</option>${instOpts}<option value="__other"${(p?.reception_church && !(store.institutions || []).some(i => i.name === p.reception_church)) ? ' selected' : ''}>Other…</option></select>
      ${_sectionHead('Sacraments to be Received at Reception')}
      ${ociaSacramentRows(p)}
    </div>`;
    h += _toggle('of-archive', 'Archive this file', !!p?.archived);
  }

  // Actions — only for the create MODAL. The inline edit form lives in the shell's
  // detail pane, which supplies its own Save / Cancel / Delete buttons.
  if (!inline) {
    h += `<div class="modal-actions" style="justify-content:space-between;">
      ${isEdit ? `<button class="btn-delete" onclick="ociaDeletePerson('${_M.id}')">Delete</button>` : '<span></span>'}
      <div style="display:flex;gap:8px;"><button class="btn-secondary" onclick="ociaCloseModal()">Cancel</button><button class="btn-primary" onclick="ociaSave()">${isEdit ? 'Save' : 'Create File'}</button></div>
    </div>`;
  }
  return h;
}

function ociaSacramentRows(p) {
  const sr = p?.sacraments_received || {};
  const def = candType(p) === 'candidate' ? { baptism: false, confirmation: true, eucharist: true } : { baptism: true, confirmation: true, eucharist: true };
  const val = (k) => (sr[k] !== undefined ? sr[k] : def[k]);
  const candidate = candType(p) === 'candidate';
  const row = (id, label, checked, disabled) => `<label style="display:flex;align-items:center;gap:8px;margin-top:.4rem;${disabled ? 'opacity:.5;' : 'cursor:pointer;'}"><input type="checkbox" id="${id}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" />${label}${disabled ? ' (not applicable)' : ''}</label>`;
  return row('of-sac-baptism', 'Baptism', candidate ? false : val('baptism'), candidate) + row('of-sac-confirmation', 'Confirmation', val('confirmation'), false) + row('of-sac-eucharist', 'First Eucharist', val('eucharist'), false);
}

function _hydrate() {
  // Refresh linked prior-spouse names from their case (source of truth) before render.
  _M.prior.forEach((m, i) => { if (m.annulment_case_id && m.prior_party) applyLinkedNames(i); });
  renderModalDocs(); renderPrior(); renderFamilyChip();
  // Lock+fill baptism City/State if a listed church is preselected (candidate only;
  // no-op when hidden/empty/"Other").
  institutionAddressSync('of-bchurch-sel', { city: 'of-bcity', state: 'of-bstate' });
}
// Baptism church dropdown change — toggle "Other" name input + autofill/grey City/State.
function ociaBaptismChange(v) {
  const wrap = document.getElementById('of-bchurch-other-wrap'); if (wrap) wrap.style.display = v === '__other' ? 'block' : 'none';
  institutionAddressAutofill(v, { city: 'of-bcity', state: 'of-bstate' });
}
function renderModalDocs() {
  const el = document.getElementById('of-docs'); if (!el) return;
  el.innerHTML = _M.docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
    <input type="checkbox" ${d.received ? 'checked' : ''} onchange="ociaDocReceived(${i},this.checked)" style="width:15px;height:15px;accent-color:var(--cardinal);" />
    <span style="font-size:13px;color:var(--navy);">${_esc(d.name)}</span>
    ${docCheckStampHtml(d)}
    ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;margin-left:8px;" title="Required"></i>` : `<button onclick="ociaRemoveDoc(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;margin-left:8px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>`}
  </div>`).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No documents.</div>`;
}
// Prior-marriage section — link-annulment-FIRST, then four name fields + "How did
// the marriage end?". When a case is linked the names autofill from the case's
// NON-OCIA party (greyed) and how-ended is derived; unlinked is fully manual.
const _PM_IN = `width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;`;
function renderPrior() {
  const wrap = document.getElementById('of-prior-wrap'); if (!wrap) return;
  wrap.innerHTML = _M.prior.map((m, i) => priorEntryHtml(m, i)).join('')
    + `<button class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;" onclick="ociaAddPrior()">+ Add prior marriage</button>`;
  _M.prior.forEach((_, i) => syncPriorLock(i));   // apply read-only cue to linked+resolved names
}
function priorEntryHtml(m, i) {
  const linked = !!m.annulment_case_id;
  const he = linked ? pmHowEnded(m) : (m.how_ended || 'Civil Divorce Only');
  const showLink = he === 'Annulment' || he === 'Civil Divorce Only';   // Death → no link field
  const cd = linked ? getCaseDisplay(m.annulment_case_id) : null;
  const ambiguous = linked && !m.prior_party;
  const nameField = (s, label, val) => `<div style="flex:1;min-width:90px;"><label>${label}</label><input type="text" id="of-pm-${s}-${i}" value="${_esc(val || '')}" style="${_PM_IN}" /></div>`;

  // 1 — Link annulment case FIRST (shown for Annulment / Civil Divorce Only).
  const linkBlock = showLink ? `<div id="of-pm-annul-${i}" style="margin-bottom:8px;">
      <label>Link annulment case</label>
      <div id="of-pm-annulsearchwrap-${i}" style="display:${linked ? 'none' : 'block'};position:relative;">
        <input type="text" id="of-pm-annulsearch-${i}" placeholder="Search annulment case…" autocomplete="off" oninput="ociaAnnulSearch(${i})" style="${_PM_IN}" />
        <div id="of-pm-annulresults-${i}" class="anl-link-results" style="display:none;"></div>
      </div>
      <div id="of-pm-annulchip-${i}" style="margin-top:6px;">${linked ? annulChip(i, m.annulment_case_id) : ''}</div>
      ${ambiguous ? partyPickerHtml(i, cd) : ''}
    </div>` : '';

  // 2 — Names (always present). Greyed (via syncPriorLock) when linked+resolved.
  const namesBlock = `<div style="display:flex;gap:8px;flex-wrap:wrap;">${nameField('first', 'First', m.first)}${nameField('middle', 'Middle', m.middle)}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">${nameField('last', 'Last', m.last)}${nameField('maiden', 'Maiden', m.maiden)}</div>
    ${linked && m.prior_party ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;"><i class="fa-solid fa-link" style="font-size:10px;"></i> Prior spouse is taken from the linked annulment case.</div>` : ''}`;

  // 3 — How did the marriage end? Disabled + derived when linked.
  const endedBlock = `<label style="margin-top:.4rem;display:block;">How did the marriage end?</label>
    <select id="of-pm-ended-${i}" onchange="ociaPriorEnded(${i},this.value)" ${linked ? 'disabled style="opacity:.6;cursor:not-allowed;"' : ''}>
      ${HOW_ENDED.map(o => `<option${he === o ? ' selected' : ''}>${o}</option>`).join('')}
    </select>
    ${linked ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;">Derived from the linked case: in progress → Civil Divorce Only; affirmed &amp; finalized → Annulment.</div>` : ''}`;

  return `<div style="background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.6rem;margin-bottom:.5rem;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;"><span style="font-size:12px;font-weight:600;color:#555;">Prior marriage ${i + 1}</span><button onclick="ociaRemovePrior(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:12px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">× Remove</button></div>
    ${linkBlock}${namesBlock}${endedBlock}
  </div>`;
}
// Ambiguous party fallback — let the user say which case party is the prior spouse.
function partyPickerHtml(i, cd) {
  return `<div style="margin-top:8px;background:#FEF9E7;border:.5px solid #F2E2B5;border-radius:var(--radius-sm);padding:.5rem .6rem;">
    <div style="font-size:12px;color:#7D6608;margin-bottom:6px;"><i class="fa-solid fa-circle-question" style="margin-right:4px;"></i>Which party is the prior spouse?</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
      <button type="button" class="btn-secondary" style="padding:.3rem .7rem;font-size:12px;" onclick="ociaPickParty(${i},'petitioner')">Petitioner — ${_esc(cd?.petitioner || '—')}</button>
      <button type="button" class="btn-secondary" style="padding:.3rem .7rem;font-size:12px;" onclick="ociaPickParty(${i},'respondent')">Respondent — ${_esc(cd?.respondent || '—')}</button>
    </div>
  </div>`;
}
// Apply the theme-safe read-only lock cue to the 4 name inputs when the entry is
// linked AND the prior-spouse party is known (names then come from the case).
function syncPriorLock(i) {
  const m = _M.prior[i]; if (!m) return;
  const locked = !!m.annulment_case_id && !!m.prior_party;
  ['first', 'middle', 'last', 'maiden'].forEach(s => setFieldLocked(document.getElementById(`of-pm-${s}-${i}`), locked));
}
function annulChip(i, caseId) { return `<span style="display:inline-flex;align-items:center;gap:8px;background:#1C2B3A;color:#fff;border-radius:14px;padding:3px 8px 3px 12px;font-size:12px;"><span>${_esc(_caseLabel(caseId))}</span><button onclick="window.expandCase('${caseId}')" style="background:none;border:none;color:#C9A84C;cursor:pointer;font-size:11px;padding:0;"><i class="fa-solid fa-arrow-up-right-from-square"></i></button><button onclick="ociaRemoveAnnul(${i})" style="background:none;border:none;color:#cdd6df;cursor:pointer;font-size:12px;padding:0;">×</button></span>`; }
function renderFamilyChip() {
  const el = document.getElementById('of-family-chip'); if (!el) return;
  el.innerHTML = _M.family ? `<span style="display:inline-flex;align-items:center;gap:8px;background:#1C2B3A;color:#fff;border-radius:14px;padding:3px 8px 3px 12px;font-size:12px;"><span>${_esc(_M.family.label)}</span><button onclick="ociaRemoveFamily()" style="background:none;border:none;color:#cdd6df;cursor:pointer;font-size:12px;padding:0;">×</button></span>` : '';
}

// modal handlers
function ociaSetType(t) {
  _M.type = t;
  document.getElementById('ot-catechumen').classList.toggle('active', t === 'catechumen');
  document.getElementById('ot-candidate').classList.toggle('active', t === 'candidate');
  document.getElementById('of-baptism-section').style.display = t === 'candidate' ? 'block' : 'none';
  if (!_M.isEdit) { _M.docs = computeTemplateDocs(t); renderModalDocs(); }
  else { // ensure candidate has baptismal cert
    if (t === 'candidate' && !_M.docs.some(d => /baptismal certificate/i.test(d.name))) { _M.docs.unshift({ name: 'Baptismal Certificate', received: false, deletable: false, auto: true }); renderModalDocs(); }
  }
}
function ociaDobChange() { const age = ociaAge(document.getElementById('of-dob').value); document.getElementById('of-minor-wrap').style.display = (age !== null && age <= 17) ? 'block' : 'none'; }
function ociaStatusChange(v) { const w = document.getElementById('of-rec-wrap'); if (w) w.style.display = (v === 'received' || v === 'complete') ? 'block' : 'none'; }
// Cohort → reception church + formation inheritance: default (editable) the reception
// church and the formation person to the cohort's. Reception church stores the church NAME.
function ociaCohortPick(v) {
  const coh = _cohorts.find(c => c.id === v);
  if (!coh) return;
  inheritCohortFormation(coh, 'of-preparer');  // default (editable) the formation person
  const rc = document.getElementById('of-rec-church');
  if (!rc || rc.value) return;                 // reception church only when its section is shown + empty
  const name = coh.church_institution_id
    ? ((store.institutions || []).find(i => i.id === coh.church_institution_id)?.name || '')
    : (coh.church_override || '');
  if (name && [...rc.options].some(o => o.value === name)) rc.value = name;
}
function ociaRecOtherChange() { _M.recOther = document.getElementById('of-rec-other').checked; document.getElementById('of-rec-date-wrap').style.display = _M.recOther ? 'block' : 'none'; document.getElementById('of-rec-easter-note').style.display = _M.recOther ? 'none' : 'block'; }
function _newPriorEntry() { return { first: '', middle: '', last: '', maiden: '', how_ended: 'Civil Divorce Only', annulment_case_id: null, prior_party: null }; }
function ociaPriorToggle() { const on = document.getElementById('of-prior-toggle').checked; document.getElementById('of-prior-wrap').style.display = on ? 'block' : 'none'; if (on && !_M.prior.length) { _M.prior = [_newPriorEntry()]; renderPrior(); } }
// Read the DOM back into _M.prior. Names read from the (possibly read-only) inputs
// so autofilled linked values are preserved; how_ended is DERIVED for linked entries
// (the disabled select is ignored) and read from the select when unlinked.
function _syncPrior() {
  _M.prior = _M.prior.map((m, i) => {
    const gv = (s) => { const el = document.getElementById(`of-pm-${s}-${i}`); return el ? el.value.trim() : (m[s] || ''); };
    const linked = !!m.annulment_case_id;
    return {
      first: gv('first'), middle: gv('middle'), last: gv('last'), maiden: gv('maiden'),
      how_ended: linked ? pmHowEnded(m) : (document.getElementById(`of-pm-ended-${i}`)?.value || m.how_ended || 'Civil Divorce Only'),
      annulment_case_id: m.annulment_case_id || null,
      prior_party: m.prior_party || null,
    };
  });
}
function ociaAddPrior() { _syncPrior(); _M.prior.push(_newPriorEntry()); renderPrior(); }
function ociaRemovePrior(i) { _syncPrior(); _M.prior.splice(i, 1); renderPrior(); }
// Unlinked how-ended change → re-render to toggle the link field (Annulment /
// Civil Divorce Only expose it; Death hides it).
function ociaPriorEnded(i, v) { _syncPrior(); _M.prior[i].how_ended = v; renderPrior(); }
// Autofill the prior-spouse names from the linked case's resolved party.
function applyLinkedNames(i) {
  const m = _M.prior[i]; if (!m || !m.annulment_case_id || !m.prior_party) return;
  const cd = getCaseDisplay(m.annulment_case_id); if (!cd) return;
  Object.assign(m, parseSpouseName(_partyName(cd, m.prior_party)));
}
// Link a case: detect which party is the OCIA person, autofill the OTHER as the
// prior spouse + grey it; ambiguous → leave names blank and show the party picker.
async function ociaLinkCase(i, caseId) {
  _syncPrior();
  _M.prior[i].annulment_case_id = caseId;
  await ensureCaseDisplays([caseId]);
  const det = detectPriorSpouseParty(getCaseDisplay(caseId), currentOciaName());
  _M.prior[i].prior_party = det.confident ? det.party : null;
  applyLinkedNames(i);
  renderPrior();
}
// User resolves the ambiguous case → set the party, autofill, grey.
function ociaPickParty(i, party) { _syncPrior(); _M.prior[i].prior_party = party; applyLinkedNames(i); renderPrior(); }
function ociaDocReceived(i, v) { applyDocCheck(_M.docs[i], v); renderModalDocs(); }
function ociaRemoveDoc(i) { _M.docs.splice(i, 1); renderModalDocs(); }
function ociaAddDoc() { const inp = document.getElementById('of-doc-new'); const name = (inp?.value || '').trim(); if (!name) return; _M.docs.push({ name, received: false, deletable: true, auto: false }); inp.value = ''; renderModalDocs(); }

async function _linkSearch(boxId, table, cols, mapper, q) {
  const box = document.getElementById(boxId); if (!box) return;
  if ((q || '').trim().length < 2) { box.style.display = 'none'; return; }
  const safe = q.replace(/[%_,()'"*]/g, ' ');
  let qb = sb.from(table).select('*');
  qb = cols.length > 1 ? qb.or(cols.map(c => `${c}.ilike.%${safe}%`).join(',')) : qb.ilike(cols[0], `%${safe}%`);
  const { data } = await qb.limit(6);
  const rows = (data || []).map(mapper);
  box.innerHTML = rows.length ? rows.map(r => `<div class="anl-link-opt" data-id="${r.id}" data-gid="${r.gid || ''}" data-label="${_esc(r.label).replace(/"/g, '&quot;')}">${_esc(r.label)}</div>`).join('') : `<div style="padding:.5rem .7rem;font-size:12px;color:#9CA3AF;">No matches</div>`;
  box.style.display = 'block'; return box;
}
async function ociaFamilySearch() {
  const q = document.getElementById('of-family-search')?.value || '';
  const box = await _linkSearch('of-family-results', 'sacramental_ocia', ['name'], r => ({ id: r.id, gid: r.family_group_id || '', label: `${r.name || '?'} — ${lastNameOf(r)} Family` }), q);
  box?.querySelectorAll('.anl-link-opt').forEach(o => o.addEventListener('mousedown', e => { e.preventDefault(); _M.family = { target_id: o.dataset.id, group_id: o.dataset.gid || null, label: `${(o.dataset.label.split(' — ')[1]) || 'Family'}` }; box.style.display = 'none'; document.getElementById('of-family-search').value = ''; renderFamilyChip(); }));
}
function ociaRemoveFamily() { _M.family = null; renderFamilyChip(); }
async function ociaAnnulSearch(i) {
  const q = document.getElementById(`of-pm-annulsearch-${i}`)?.value || '';
  const box = await _linkSearch(`of-pm-annulresults-${i}`, 'annulment_cases', ['petitioner', 'respondent'], r => ({ id: r.id, label: `${r.petitioner || ''}${r.respondent ? ' v. ' + r.respondent : ''}` }), q);
  box?.querySelectorAll('.anl-link-opt').forEach(o => o.addEventListener('mousedown', e => { e.preventDefault(); box.style.display = 'none'; ociaLinkCase(i, o.dataset.id); }));
}
// Unlink → names become manually editable again; clear the resolved party. Keep the
// (now manual) how_ended seeded from whatever it was so the entry stays valid.
function ociaRemoveAnnul(i) { _syncPrior(); const m = _M.prior[i]; m.annulment_case_id = null; m.prior_party = null; if (!m.how_ended) m.how_ended = 'Civil Divorce Only'; renderPrior(); }

// ── Save ─────────────────────────────────────────────────────────────────────
function _v(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function _chk(id) { return !!document.getElementById(id)?.checked; }
// Shared DOM→payload reader (create modal AND shell inline edit). Returns
// { ok, payload, familyGroupId, linkTargetToUpdate }. The `preparer` field was
// dropped (OCIA has no formation field in Phase 2; the column does not exist).
function _ociaReadPayload() {
  _syncPrior();
  const name = [_v('of-first'), _v('of-middle'), _v('of-last')].filter(Boolean).join(' ');
  if (!name) return { ok: false };
  const type = _M.type;
  const age = ociaAge(_v('of-dob'));
  const minor = age !== null && age <= 17;
  const cohortSel = document.getElementById('of-cohort')?.value || '';
  const coh = _cohorts.find(c => c.id === cohortSel);

  let familyGroupId = null, linkTargetToUpdate = null;
  if (_M.family) {
    if (_M.family.group_id) familyGroupId = _M.family.group_id;
    else { familyGroupId = (crypto?.randomUUID?.() || String(Date.now())); if (_M.family.target_id) linkTargetToUpdate = _M.family.target_id; }
  }

  const payload = {
    name, candidate_type: type, baptismal_status: type === 'candidate' ? 'baptized' : 'unbaptized',
    preparer: readPreparerValue('of-preparer'),
    cohort_id: cohortSel || null, cohort_date: coh?.cohort_date || null,
    phone: normalizePhone(_v('of-phone')) || null, email: _v('of-email') || null, dob: _v('of-dob') || null,
    parental_consent: minor ? _chk('of-consent') : false,
    minor_guardian_name: minor ? (_v('of-guardian') || null) : null,
    minor_permission_date: minor ? (_v('of-permdate') || null) : null,
    consent_parent_name: minor && _chk('of-consent') ? (_v('of-guardian') || null) : null,
    consent_date: minor && _chk('of-consent') ? (_v('of-permdate') || null) : null,
    baptism_church: type === 'candidate' ? institutionSelectedName(document.getElementById('of-bchurch-sel')?.value, 'of-bchurch-name') : null,
    baptism_city: type === 'candidate' ? (_v('of-bcity') || null) : null,
    baptism_state: type === 'candidate' ? (_v('of-bstate') || null) : null,
    baptism_country: type === 'candidate' ? (_v('of-bcountry') || null) : null,
    sponsor_name: _v('of-sponsor') || null,
    prior_marriages: _M.prior.filter(m => m.first || m.middle || m.last || m.maiden || m.annulment_case_id).map(_priorToStore),
    documents: _M.docs,
    family_group_id: familyGroupId,
    updated_at: nowIso(),
  };
  return { ok: true, payload, familyGroupId, linkTargetToUpdate };
}

// Apply edit-only fields (status / reception / sacraments / archive). OCIA carries
// no timeline (removed) — no auto-stamping here.
function _ociaApplyEditFields(payload, prior) {
  const type = _M.type;
  const newStatus = document.getElementById('of-status')?.value || prior?.status_code || 'inquirer';
  payload.status_code = newStatus;
  payload.archived = _chk('of-archive');
  if (newStatus === 'received' || newStatus === 'complete') {
    const easterVal = document.getElementById('of-rec-wrap')?.dataset.easter || null;
    payload.reception_is_easter_vigil = !_M.recOther;
    payload.reception_date = _M.recOther ? (_v('of-rec-date') || null) : easterVal;
    payload.reception_date_type = _M.recOther ? 'custom' : 'easter';
    const churchSel = document.getElementById('of-rec-church')?.value || '';
    payload.reception_church = churchSel && churchSel !== '__other' ? churchSel : (churchSel === '__other' ? prior?.reception_church || null : null);
    payload.sacraments_received = { baptism: type === 'catechumen' ? _chk('of-sac-baptism') : false, confirmation: _chk('of-sac-confirmation'), eucharist: _chk('of-sac-eucharist') };
  }
}

// Create flow (modal).
async function ociaSave() {
  const r = _ociaReadPayload();
  if (!r.ok) { alert('Candidate name is required.'); return; }
  if (_M.isEdit) { const res = await ociaSaveEdit(_M.id); if (res.ok) { window.flashSavedThen(() => { ociaCloseModal(); refreshActivePanel(); }); } return; }
  const { payload, familyGroupId, linkTargetToUpdate } = r;
  payload.status_code = document.getElementById('of-status')?.value || 'inquirer';
  payload.archived = false;
  const { error } = await insertWithRetry('sacramental_ocia', payload);
  if (error) { reportWriteError('ocia insert', error); return; }
  if (linkTargetToUpdate) await sb.from('sacramental_ocia').update({ family_group_id: familyGroupId }).eq('id', linkTargetToUpdate);
  logActivity({ action: 'added OCIA candidate', entityType: 'ocia', entityName: payload.name, contextType: 'ocia' });
  const { data: { user } } = await sb.auth.getUser();
  const uids = await getUserIdsForSacrament('ocia');
  notifyUsers(uids, user?.id, `New OCIA candidate added: ${payload.name}`, 'info', 'ocia');
  window.flashSavedThen(async () => { ociaCloseModal(); await loadOciaData(); refreshActivePanel(); });
}

// ── Shell config hooks (inline edit form + save/delete) ──────────────────────
export function buildOciaEditForm(p) {
  _M = newModalState(p, candType(p));
  const html = buildModalHtml(p, { inline: true });
  setTimeout(() => _hydrate(), 0);
  return html;
}
export async function ociaSaveEdit(id) {
  const r = _ociaReadPayload();
  if (!r.ok) { alert('Candidate name is required.'); return { ok: false }; }
  const { payload, familyGroupId, linkTargetToUpdate } = r;
  const prior = allOcia.find(x => x.id === id);
  _ociaApplyEditFields(payload, prior);
  const { error } = await withWriteRetry(() => sb.from('sacramental_ocia').update(payload).eq('id', id), { kind: 'update' });
  if (error) { reportWriteError('ocia update', error); return { ok: false }; }
  if (linkTargetToUpdate) await sb.from('sacramental_ocia').update({ family_group_id: familyGroupId }).eq('id', linkTargetToUpdate);
  logActivity({ action: 'updated OCIA record', entityType: 'ocia', entityName: payload.name, contextType: 'ocia', contextId: id });
  await loadOciaData();
  return { ok: true };
}
export async function ociaDeleteRec(id) {
  if (!confirm('Permanently delete this record? This cannot be undone.')) return { ok: false };
  const { error } = await deleteWithRetry(() => sb.from('sacramental_ocia').delete().eq('id', id));
  if (error) { reportWriteError('ocia delete', error); return { ok: false }; }
  allOcia = allOcia.filter(x => x.id !== id); store.allOcia = allOcia;
  logActivity({ action: 'deleted OCIA record', entityType: 'ocia', entityName: id, contextType: 'ocia' });
  return { ok: true };
}
async function ociaDeletePerson(id) {   // modal Delete button
  const res = await ociaDeleteRec(id);
  if (res.ok) { ociaCloseModal(); refreshActivePanel(); }
}

// ── Cohort manager — shared module (src/sacramental/cohortManager.js) ─────────
registerCohortManager({
  panel: 'ocia', idPrefix: 'ocoh', dateLabel: 'Reception Date', stateLabel: 'State/Province',
  noun: 'person', pluralNoun: 'people', deleteNote: 'People keep their data but lose the cohort link.',
  coordinatorNames: () => _ociaCoordinatorNames,
  getCohorts: () => _cohorts, getRecords: () => allOcia,
  open: (html) => _ociaOpen(html), close: () => ociaCloseModal(),
  reloadCohorts: () => loadCohorts(), refresh: () => refreshActivePanel(),
});

// ── Templates ────────────────────────────────────────────────────────────────
let _tplState = null, _tplActive = 'catechumen';
function openOciaTemplates() { _tplState = JSON.parse(JSON.stringify(_templates)); _tplActive = 'catechumen'; _ociaOpen(buildTplHtml()); renderTplDocs(); }
function buildTplHtml() {
  const tabs = [['catechumen', 'Catechumen'], ['candidate', 'Candidate']].map(([v, l]) => `<button class="anl-tpl-tab${_tplActive === v ? ' active' : ''}" data-v="${v}" onclick="ociaTplTab('${v}')">${l}</button>`).join('');
  return `<div class="modal-title">OCIA Templates</div>
    <div style="display:flex;gap:4px;margin-bottom:1rem;border-bottom:.5px solid var(--stone);padding-bottom:8px;">${tabs}</div>
    <div style="font-size:12px;color:#6B7280;margin-bottom:8px;">🔒 Locked documents are required and cannot be removed.</div>
    <div id="ocia-tpl-docs"></div>
    <div style="display:flex;gap:6px;margin-top:8px;"><input type="text" id="ocia-tpl-new" placeholder="Add document…" style="flex:1;border-radius:6px;border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();ociaTplAdd();}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="ociaTplAdd()">+ Add</button></div>
    <div style="font-size:12px;color:#6B7280;font-style:italic;margin-top:1rem;">Changes apply to new files only.</div>
    <div class="modal-actions"><button class="btn-secondary" onclick="ociaCloseModal()">Cancel</button><button class="btn-primary" onclick="ociaTplSave()">Save Template</button></div>`;
}
function renderTplDocs() {
  const el = document.getElementById('ocia-tpl-docs'); if (!el) return;
  const docs = _tplState[_tplActive] || [];
  el.innerHTML = docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;"><span style="flex:1;font-size:13px;">${_esc(d.name)}</span>${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;"></i>` : `<button onclick="ociaTplRemove(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:14px;">×</button>`}</div>`).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No documents.</div>`;
}
function ociaTplTab(v) { _tplActive = v; document.querySelectorAll('#ocia-overlay .anl-tpl-tab').forEach(b => b.classList.toggle('active', b.dataset.v === v)); renderTplDocs(); }
function ociaTplAdd() { const inp = document.getElementById('ocia-tpl-new'); const n = (inp?.value || '').trim(); if (!n) return; (_tplState[_tplActive] = _tplState[_tplActive] || []).push({ name: n, deletable: true }); inp.value = ''; renderTplDocs(); }
function ociaTplRemove(i) { _tplState[_tplActive].splice(i, 1); renderTplDocs(); }
async function ociaTplSave() {
  const docs = _tplState[_tplActive] || [];
  const { error } = await sb.from('ocia_templates').upsert({ candidate_type: _tplActive, documents: docs, updated_at: nowIso() }, { onConflict: 'candidate_type' });
  if (error) { alert('Save failed: ' + error.message); return; }
  _templates[_tplActive] = docs;
  window.flashSaved();   // shared green "Saved ✓" confirmation
}

Object.assign(window, {
  expandOcia, expandCase,
  openOciaCreate, openOciaEdit, openOciaTemplates, ociaCloseModal,
  ociaSetType, ociaDobChange, ociaStatusChange, ociaRecOtherChange, ociaCohortPick, ociaBaptismChange,
  ociaPriorToggle, ociaAddPrior, ociaRemovePrior, ociaPriorEnded, ociaPickParty,
  ociaDocReceived, ociaRemoveDoc, ociaAddDoc,
  ociaFamilySearch, ociaRemoveFamily, ociaAnnulSearch, ociaRemoveAnnul,
  ociaSave, ociaDeletePerson,
  // Viewer-editable notes + minor permission (write-retry wrapped).
  ociaAddNote, ociaDeleteNote, ociaSavePermField, ociaTogglePermission,
  ociaTplTab, ociaTplAdd, ociaTplRemove, ociaTplSave,
});
