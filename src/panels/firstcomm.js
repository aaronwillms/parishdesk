import { sb, withWriteRetry, serializeWrite, insertWithRetry, deleteWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, formatDateDisplay, todayCST, logActivity, reportWriteError, applyDocCheck, docCheckStampHtml } from '../utils.js';
import { isAdmin, canAccessSacrament, isSacramentCoordinator } from '../roles.js';
import { notifyUsers, getUserIdsForSacrament } from '../notifications.js';
import { formatPhone, normalizePhone } from '../utils/phone.js';
import { renderSacramentalPanel, refreshActivePanel, openSacramentalRecord } from '../sacramental/panelShell.js';
import { editNoteLog } from '../sacramental/noteEdit.js';
import { sealGuardConfirm } from '../ui/sealGuard.js';
import { buildPreparerField, readPreparerValue } from '../sacramental/preparerField.js';
import { registerFamilyPanel, familyAddPickerHtml, getPendingAdd, clearPendingAdd, familyLink } from '../sacramental/familyLink.js';
import { detailsChurchToggle, detailsCityState, inheritCohortChurch, inheritCohortFormation,
  institutionAddressAutofill, institutionOptionsHtml, institutionSelectedName, institutionAddressSync } from '../sacramental/churchLocation.js';
import { registerCohortManager } from '../sacramental/cohortManager.js';

const FC_STATUS = {
  enrolled:    { label:'Enrolled',         color:'#4A1D96', bg:'#EDE9FE', dot:'#7C3AED' },  // purple
  preparation: { label:'In Preparation',   color:'#7D6608', bg:'#FEF9E7', dot:'#D4AC0D' },  // yellow
  complete:    { label:'Complete',         color:'#2D6A4F', bg:'#D8F3DC', dot:'#2D6A4F' },  // green
  inactive:    { label:'Inactive',         color:'#616A6B', bg:'#F2F3F4', dot:'#AAB7B8' },  // grey
};
const COUNTRIES = ['United States of America', 'Mexico', 'Philippines', 'Vietnam', 'Nigeria', 'India', 'Other'];
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
const FALLBACK_DOCS = [{ name: 'Baptismal Certificate', deletable: false }];

let allFc = [], fcFilter = 'all', fcExpanded = null, _cohortFilter = 'all';
let _cohorts = [], _tplDocs = [], _M = null, _fcCoordinatorNames = [];

function fullAccess() { return isAdmin() || canAccessSacrament('first_communion') || canAccessSacrament('firstcomm'); }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _curUserName() { return store.currentUserProfile?.personnel?.name || 'Staff'; }
function nowIso() { return new Date().toISOString(); }
function ageOf(dob) { if (!dob) return null; const d = new Date(dob); if (isNaN(d)) return null; const now = new Date(new Date().toLocaleString('en-US', { timeZone: store.parishSettings?.timezone || 'America/Chicago' })); let a = now.getFullYear() - d.getFullYear(); const m = now.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--; return a; }
function cohortLabel(dateStr) { if (!dateStr) return 'No date'; const d = new Date(dateStr + 'T00:00:00'); return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }

// ── Field accessors (backward-compatible) ────────────────────────────────────
function nameOf(p) { return (p.first_name || p.last_name) ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : (p.name || '—'); }
function lastNameOf(p) { if (p.last_name) return p.last_name; const parts = (p.name || '').trim().split(/\s+/); return parts[parts.length - 1] || ''; }
function statusOf(p) { return p.status_code || 'enrolled'; }
function commDate(p) { return p ? (p.communion_date || p.sacrament_date || null) : null; }
function normDocs(p) { return (p.documents || []).map(d => ({ name: d.name, received: d.received ?? d.done ?? false, deletable: d.deletable ?? !d.auto, auto: !!d.auto, checked_on: d.checked_on || null })); }
function notesOf(p) {
  const out = (Array.isArray(p.notes_log) ? p.notes_log : []).map(n => ({ note: n.note || '', by: n.by || null, created_at: n.created_at || null, edited_at: n.edited_at || null }));
  if (p.notes && String(p.notes).trim()) out.push({ note: String(p.notes).trim(), by: null, created_at: null, legacy: true });
  return out;
}

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadTemplate() { const { data } = await sb.from('firstcomm_templates').select('documents').limit(1); _tplDocs = (data && data[0]?.documents) || JSON.parse(JSON.stringify(FALLBACK_DOCS)); }
async function loadCohorts() { const { data } = await sb.from('sacramental_cohorts').select('*').eq('panel', 'firstcomm').order('cohort_date', { ascending: false }); _cohorts = data || []; }
async function loadFcCoordinator() {
  try {
    const { data } = await sb.from('program_coordinators').select('coordinator_ids').eq('program', 'firstcomm').maybeSingle();
    _fcCoordinatorNames = (data?.coordinator_ids || []).map(pid => (store.personnel || []).find(p => p.id === pid)?.name).filter(Boolean);
  } catch (_) { _fcCoordinatorNames = []; }
}

// Data-only refresh (used by the shell + autosave). Returns the record list.
export async function loadFcData() {
  await Promise.all([loadTemplate(), loadCohorts(), loadFcCoordinator()]);
  // Parish-scope (Step 2a): the user's resolved parish, OR group-shared NULL rows. Single-
  // parish → all rows are Basilica, so this returns today's rows.
  const _pid = store.parishSettings?.id;
  let _q = sb.from('sacramental_firstcomm').select('*').order('created_at', { ascending: false });
  if (_pid) _q = _q.or(`parish_id.is.null,parish_id.eq.${_pid}`);
  const { data, error } = await _q;
  if (error) { console.error('[firstcomm]', error); return []; }
  allFc = data || [];
  store.allFirstComm = allFc;
  updateStats();
  return allFc;
}

// Nav loader — fetch then mount the master-detail shell into #firstcomm-root.
export async function loadFirstComm() {
  await loadFcData();
  const root = document.getElementById('firstcomm-root');
  if (!root) return;
  const { firstCommunionConfig } = await import('../sacramental/firstCommunionConfig.js');
  renderSacramentalPanel(root, firstCommunionConfig);
}

// ── Shell accessors (consumed by firstCommunionConfig) ───────────────────────
export function getFcRecords() { return allFc; }
export function getFcRecord(id) { return allFc.find(x => x.id === id) || null; }
export { fullAccess as fcCanManage };
export { FC_STATUS };
export function cohortKeyOf(p) { return p?.cohort_id || null; }
export function cohortName(cohortId) {
  if (!cohortId) return 'Unassigned';
  const coh = _cohorts.find(c => c.id === cohortId);
  return cohortLabel(coh?.cohort_date) + (cohortChurchName(coh) ? ` · ${cohortChurchName(coh)}` : '');
}
export function cohortDateOf(cohortId) { return _cohorts.find(c => c.id === cohortId)?.cohort_date || ''; }
export function preparerOf(p) { return p?.preparer || ''; }
export function communionChurch(p) {
  if (p?.communion_institution_id) return (store.institutions || []).find(x => x.id === p.communion_institution_id)?.name || '';
  return p?.communion_church_override || '';
}
export { nameOf, lastNameOf, statusOf, commDate, cohortLabel, cohortChurchName, normDocs, notesOf, ageOf };

// Register this panel with the shared family-link mechanism (sacramental/familyLink.js).
registerFamilyPanel('firstcomm', {
  table: 'sacramental_firstcomm',
  nameOf: (r) => nameOf(r),
  getAll: () => allFc,
  refresh: async () => { await loadFcData(); refreshActivePanel(); },
  canManage: () => fullAccess(),
  noun: 'student',
});

function updateStats() {
  const active = allFc.filter(p => !p.archived && statusOf(p) !== 'inactive');
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('stat-fc-total', active.length);
  set('stat-fc-upcoming', active.filter(p => commDate(p) && commDate(p) >= todayCST() && statusOf(p) !== 'received').length);
  set('stat-fc-docs', active.filter(p => normDocs(p).some(d => !d.received)).length);
}

function cohortChurchName(coh) { if (!coh) return ''; if (coh.church_institution_id) { const i = (store.institutions || []).find(x => x.id === coh.church_institution_id); if (i) return i.name; } return coh.church_override || ''; }

// Cross-link entry — open a specific First Communion file in the shell (deep-link).
export async function expandFirstComm(id) {
  openSacramentalRecord('firstcommunion', id);   // set hash first so the shell opens it on mount
  window.switchPanel('firstcomm');
}

// ── Autosave ─────────────────────────────────────────────────────────────────
async function _patch(id, patch) { const p = allFc.find(x => x.id === id); if (!p) return null; const { error } = await serializeWrite(`firstcomm:${id}`, () => withWriteRetry(() => sb.from('sacramental_firstcomm').update({ ...patch, updated_at: nowIso() }).eq('id', id), { kind: 'update' })); if (error) { alert('Save failed: ' + error.message); return null; } Object.assign(p, patch); return p; }
async function toggleFcDoc(id, i) {
  const p = allFc.find(x => x.id === id); if (!p) return;
  const docs = normDocs(p); applyDocCheck(docs[i], !docs[i].received);
  const prevAll = normDocs(p).length > 0 && normDocs(p).every(d => d.received);
  const allDone = docs.length > 0 && docs.every(d => d.received);
  const patch = { documents: docs };
  if (allDone && !prevAll) { const tl = JSON.parse(JSON.stringify(p.timeline || [])); tl.push({ type: 'auto', text: 'All documents received', created_at: nowIso() }); patch.timeline = tl; }
  if (await _patch(id, patch)) { updateStats(); refreshActivePanel(); }
}
async function addFcNote(id) {
  const inp = document.getElementById('fcn-' + id); const note = (inp?.value || '').trim(); if (!note) return;
  const p = allFc.find(x => x.id === id); if (!p) return;
  if (!(await sealGuardConfirm(note))) return;   // shared seal-of-confession guard on the note
  const log = Array.isArray(p.notes_log) ? JSON.parse(JSON.stringify(p.notes_log)) : [];
  log.push({ note, by: _curUserName(), created_at: nowIso() });
  if (await _patch(id, { notes_log: log })) window.flashSavedThen(() => refreshActivePanel());
}
// Edit a notes_log note in place (shared shape): overwrite text + stamp edited_at.
async function fcEditNote(id, idx) {
  const p = allFc.find(x => x.id === id); if (!p) return;
  const log = editNoteLog(p.notes_log, idx, nowIso);
  if (!log) return;
  if (!(await sealGuardConfirm(log[idx].note))) return;   // shared seal guard on the edited note
  if (await _patch(id, { notes_log: log })) window.flashSavedThen(() => refreshActivePanel());
}

// ── Big modal ────────────────────────────────────────────────────────────────
function _fcOverlay() { let ov = document.getElementById('fc-overlay'); if (!ov) { ov = document.createElement('div'); ov.id = 'fc-overlay'; ov.className = 'modal-overlay'; ov.innerHTML = `<div class="modal anl-modal"><button class="modal-close" onclick="fcCloseModal()">×</button><div id="fc-modal-content"></div></div>`; document.body.appendChild(ov); ov.addEventListener('click', e => { if (e.target === ov) fcCloseModal(); }); } return ov; }
function _fcOpen(html) { _fcOverlay(); document.getElementById('fc-modal-content').innerHTML = html; document.getElementById('fc-overlay').classList.add('open'); }
function fcCloseModal() { document.getElementById('fc-overlay')?.classList.remove('open'); _M = null; }

function _row(...cells) { return `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cells.map(c => `<div style="flex:1;min-width:120px;">${c}</div>`).join('')}</div>`; }
function _input(id, label, val = '', type = 'text') { return `<label>${label}</label><input type="${type}" id="${id}" value="${_esc(val)}" />`; }
function _stateSelect(id, val) { return `<label>State</label><select id="${id}"><option value="">—</option>${US_STATES.map(s => `<option${s === val ? ' selected' : ''}>${s}</option>`).join('')}</select>`; }
function _toggle(id, label, on, onchange = '') { return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:.75rem;"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${onchange ? `onchange="${onchange}"` : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" />${label}</label>`; }
function _sectionHead(t) { return `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--cardinal);margin:1.4rem 0 .5rem;border-bottom:.5px solid var(--stone);padding-bottom:4px;">${t}</div>`; }
// Grade dropdown 2–12, default 2. An out-of-range stored grade (legacy K/1/Other)
// is preserved as a leading option so editing a record never silently drops it.
const GRADE_OPTS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
function _gradeSelect(id, current) {
  const cur = current || '2';
  const extra = (cur && !GRADE_OPTS.includes(cur)) ? `<option selected>${_esc(cur)}</option>` : '';
  return `<label>Grade Level</label><select id="${id}">${extra}${GRADE_OPTS.map(g => `<option${g === cur ? ' selected' : ''}>${g}</option>`).join('')}</select>`;
}
// Institution dropdown ("— Select —" + institutions + "Other…") for a text-stored
// church/school field. `name` is the stored NAME (preselected by match); the
// dropdown VALUES are institution ids so institutionAddressAutofill can resolve
// the address. `onchange` is the window handler that toggles the override + autofills.
function _instSelect(id, name, onchange) {
  const { options, isOther } = institutionOptionsHtml(name);
  return `<select id="${id}" onchange="${onchange}(this.value)"><option value="">— Select —</option>${options}<option value="__other"${isOther ? ' selected' : ''}>Other…</option></select>`;
}

async function openFcCreate() {
  clearPendingAdd('firstcomm');
  _M = newModalState(null);
  _fcOpen(buildModalHtml(null)); _hydrate();
}
function openFcEdit(id) { const p = allFc.find(x => x.id === id); if (!p) return; _M = newModalState(p); _fcOpen(buildModalHtml(p)); _hydrate(); }
function newModalState(p) {
  return {
    id: p?.id || null, isEdit: !!p,
    docs: p ? normDocs(p) : computeTemplateDocs(),
  };
}
function computeTemplateDocs() {
  const base = (_tplDocs || FALLBACK_DOCS).map(d => ({ name: d.name, received: false, deletable: d.deletable ?? true, auto: d.deletable === false }));
  if (!base.some(d => /baptismal certificate/i.test(d.name))) base.unshift({ name: 'Baptismal Certificate', received: false, deletable: false, auto: true });
  return base;
}
function _nameParts(p) { return { first: p?.first_name || (p?.name || '').split(/\s+/)[0] || '', middle: p?.middle_name || '', last: p?.last_name || (p?.name || '').split(/\s+/).slice(1).join(' ') || '' }; }

function buildModalHtml(p, opts = {}) {
  const inline = !!opts.inline;
  const isEdit = _M.isEdit;
  const np = _nameParts(p);
  const age = ageOf(p?.dob);
  const instOpts = (store.institutions || []).map(i => `<option value="${i.id}"${p?.communion_institution_id === i.id ? ' selected' : ''}>${_esc(i.name)}</option>`).join('');
  const cohortOpts = _cohorts.map(c => `<option value="${c.id}"${p?.cohort_id === c.id ? ' selected' : ''}>${cohortLabel(c.cohort_date)}</option>`).join('');

  let h = inline ? '' : `<div class="modal-title">${isEdit ? 'Edit First Communion File' : 'New First Communion Student'}</div>`;

  // 1 — Cohort FIRST (SELECT an existing cohort only; cohorts are created in the panel
  // via Manage Cohorts, never from here). Picking it first defaults BOTH the church
  // and the formation person (see fcCohortPick → inheritCohortChurch + inheritCohortFormation).
  h += _sectionHead('Cohort');
  if (_cohorts.length) {
    h += `<label>Cohort</label><select id="ff-cohort" onchange="fcCohortPick(this.value)"><option value="">— None —</option>${cohortOpts}</select>`;
  } else {
    h += `<label>Cohort</label><select id="ff-cohort" disabled style="color:#9CA3AF;"><option value="">No cohorts yet</option></select>
      <div style="font-size:11.5px;color:#9CA3AF;margin-top:4px;">Create a cohort first via <strong>Manage Cohorts</strong> in the First Communion panel.</div>`;
  }

  // 2 — Person responsible for formation (clergy + FC coordinator + Other)
  h += _sectionHead('Person Responsible for Formation');
  h += buildPreparerField('ff-preparer', p?.preparer || '', { coordinatorNames: _fcCoordinatorNames, label: 'Person Responsible for Formation' });

  // 3 — Child info
  h += _sectionHead('Child Information');
  h += _row(_input('ff-first', 'First Name', np.first), _input('ff-middle', 'Middle', np.middle), _input('ff-last', 'Last Name', np.last));
  h += `<label>Date of Birth</label><input type="date" id="ff-dob" value="${(p?.dob && /^\d{4}-\d{2}-\d{2}/.test(p.dob)) ? p.dob.slice(0, 10) : ''}" oninput="fcDobChange()" />`;
  h += `<div id="ff-age-note" class="anl-info-box" style="display:${age !== null && age > 13 ? 'block' : 'none'};">For older candidates, consider the Confirmation or OCIA panel.</div>`;
  // School — institution dropdown + Other. Selecting a listed school autofills +
  // greys its Street/City/State (from the institution record). Name round-trips
  // via school_name; the address persists to school_street/city/state (school_address migration).
  const schoolName = p?.school_name || '';
  const schoolOther = institutionOptionsHtml(schoolName).isOther;
  h += _row(`<label>School</label>${_instSelect('ff-school-sel', schoolName, 'fcSchoolChange')}`, _gradeSelect('ff-grade', p?.grade_level || p?.grade));
  h += `<div id="ff-school-other-wrap" style="display:${schoolOther ? 'block' : 'none'};margin-top:6px;">${_input('ff-school-name', 'School name', schoolOther ? schoolName : '')}</div>`;
  h += _input('ff-school-street', 'School Street Address', p?.school_street || '');
  h += _row(_input('ff-school-city', 'School City', p?.school_city || ''), _stateSelect('ff-school-state', p?.school_state || ''));
  h += _input('ff-street', 'Mailing Street Address', p?.child_street || '');
  h += _row(_input('ff-city', 'City', p?.child_city || ''), _stateSelect('ff-state', p?.child_state || ''), _input('ff-zip', 'ZIP', p?.child_zip || ''));

  // 4 — Parents
  h += _sectionHead('Parent/Guardian Contact');
  h += _row(_input('ff-p1first', 'First Name', p?.parent1_first || ''), _input('ff-p1last', 'Last Name', p?.parent1_last || ''));
  h += _row(_input('ff-p1phone', 'Cell Phone', p?.parent1_phone || p?.phone || '', 'tel'), _input('ff-p1email', 'Email', p?.parent1_email || p?.email || ''));

  // 5 — Baptism
  h += _sectionHead('Baptism Information');
  // Church of Baptism — institution dropdown + Other; a listed church autofills +
  // greys City/State (name round-trips via baptism_church).
  const bchName = p?.baptism_church || '';
  const bchOther = institutionOptionsHtml(bchName).isOther;
  h += `<label>Church of Baptism</label>${_instSelect('ff-bchurch-sel', bchName, 'fcBaptismChange')}`;
  h += `<div id="ff-bchurch-other-wrap" style="display:${bchOther ? 'block' : 'none'};margin-top:6px;">${_input('ff-bchurch-name', 'Church name', bchOther ? bchName : '')}</div>`;
  h += _row(_input('ff-bcity', 'City', p?.baptism_city || ''), _stateSelect('ff-bstate', p?.baptism_state || ''));
  h += `<label>Country</label><select id="ff-bcountry">${COUNTRIES.map(co => `<option${(p?.baptism_country || 'United States of America') === co ? ' selected' : ''}>${co}</option>`).join('')}</select>`;

  // 6 — First communion details
  h += _sectionHead('First Communion Details');
  h += _input('ff-cdate', 'First Communion Date', commDate(p) || '', 'date');
  h += `<label>Church</label><select id="ff-church" onchange="fcChurchChange(this.value)"><option value="">— Select —</option>${instOpts}<option value="__other"${(p?.communion_church_override && !p?.communion_institution_id) ? ' selected' : ''}>Other…</option></select>
    <div id="ff-church-other-wrap" style="display:${(p?.communion_church_override && !p?.communion_institution_id) ? 'block' : 'none'};">
      ${_input('ff-church-override', 'Church name', p?.communion_church_override || '')}
      ${_row(_input('ff-ccity', 'City', p?.communion_city || ''), _stateSelect('ff-cstate', p?.communion_state || ''))}
    </div>`;

  // 7 — Documents
  h += _sectionHead('Document Checklist');
  h += `<div id="ff-docs"></div><div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="ff-doc-new" placeholder="Add document…" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();fcAddDoc();}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="fcAddDoc()">+ Add</button></div>`;

  // 8 — Family (Add only; for an existing file, family is managed in the file view)
  if (!isEdit) {
    h += _sectionHead('Family');
    h += `<div style="font-size:11.5px;color:#9CA3AF;margin-bottom:6px;">Link this student to a sibling already on file — they’ll share one family group.</div>`;
    h += familyAddPickerHtml('firstcomm');
  }

  if (isEdit) {
    h += _sectionHead('Status');
    h += `<label>Status</label><select id="ff-status">${Object.entries(FC_STATUS).map(([k, v]) => `<option value="${k}"${statusOf(p) === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`;
    h += _toggle('ff-archive', 'Archive this file', !!p?.archived);
  }

  if (!inline) {
    h += `<div class="modal-actions" style="justify-content:space-between;">
      ${isEdit ? `<button class="btn-delete" onclick="fcDeletePerson('${_M.id}')">Delete</button>` : '<span></span>'}
      <div style="display:flex;gap:8px;"><button class="btn-secondary" onclick="fcCloseModal()">Cancel</button><button class="btn-primary" onclick="fcSave()">${isEdit ? 'Save' : 'Create File'}</button></div>
    </div>`;
  }
  return h;
}

function _hydrate() {
  renderModalDocs();
  // Lock+fill address fields for any preselected listed institution (onchange only
  // fires on user interaction). No-op for "Other"/none so manual values persist.
  institutionAddressSync('ff-school-sel', { street: 'ff-school-street', city: 'ff-school-city', state: 'ff-school-state' });
  institutionAddressSync('ff-bchurch-sel', { city: 'ff-bcity', state: 'ff-bstate' });
}
// School dropdown change — toggle the "Other" name input + autofill/grey address.
function fcSchoolChange(v) {
  const wrap = document.getElementById('ff-school-other-wrap'); if (wrap) wrap.style.display = v === '__other' ? 'block' : 'none';
  institutionAddressAutofill(v, { street: 'ff-school-street', city: 'ff-school-city', state: 'ff-school-state' });
}
// Baptism church dropdown change — toggle "Other" name input + autofill/grey City/State.
function fcBaptismChange(v) {
  const wrap = document.getElementById('ff-bchurch-other-wrap'); if (wrap) wrap.style.display = v === '__other' ? 'block' : 'none';
  institutionAddressAutofill(v, { city: 'ff-bcity', state: 'ff-bstate' });
}
function renderModalDocs() {
  const el = document.getElementById('ff-docs'); if (!el) return;
  el.innerHTML = _M.docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
    <input type="checkbox" ${d.received ? 'checked' : ''} onchange="fcDocReceived(${i},this.checked)" style="width:15px;height:15px;accent-color:var(--cardinal);" />
    <span style="font-size:13px;color:var(--navy);">${_esc(d.name)}</span>
    ${docCheckStampHtml(d)}
    ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;margin-left:8px;" title="Required"></i>` : `<button onclick="fcRemoveDoc(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;margin-left:8px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>`}
  </div>`).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No documents.</div>`;
}

function fcCohortPick(v) {
  const coh = _cohorts.find(c => c.id === v);
  if (coh?.cohort_date) { const dt = document.getElementById('ff-cdate'); if (dt && !dt.value) dt.value = coh.cohort_date; }
  inheritCohortChurch(coh, 'ff');             // default (editable) the church to the cohort's
  inheritCohortFormation(coh, 'ff-preparer'); // default (editable) the formation person too
}
function fcDobChange() { const age = ageOf(document.getElementById('ff-dob').value); document.getElementById('ff-age-note').style.display = (age !== null && age > 13) ? 'block' : 'none'; }
function fcChurchChange(v) { detailsChurchToggle(v, 'ff'); }
function fcDocReceived(i, v) { applyDocCheck(_M.docs[i], v); renderModalDocs(); }
function fcRemoveDoc(i) { _M.docs.splice(i, 1); renderModalDocs(); }
function fcAddDoc() { const inp = document.getElementById('ff-doc-new'); const name = (inp?.value || '').trim(); if (!name) return; _M.docs.push({ name, received: false, deletable: true, auto: false }); inp.value = ''; renderModalDocs(); }

// ── Save ─────────────────────────────────────────────────────────────────────
function _v(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function _chk(id) { return !!document.getElementById(id)?.checked; }
// Shared payload reader — used by the create modal AND the shell inline edit
// (both render the same field ids + drive the same _M state).
function _fcReadPayload() {
  const first = _v('ff-first'), last = _v('ff-last');
  const name = [first, _v('ff-middle'), last].filter(Boolean).join(' ');
  if (!name) return { ok: false };
  const cohortSel = document.getElementById('ff-cohort')?.value || '';
  const coh = _cohorts.find(c => c.id === cohortSel);
  const churchSel = document.getElementById('ff-church')?.value || '';

  const payload = {
    name, first_name: first || null, middle_name: _v('ff-middle') || null, last_name: last || null,
    dob: _v('ff-dob') || null,
    cohort_id: cohortSel || null, cohort_date: coh?.cohort_date || null,
    preparer: readPreparerValue('ff-preparer'),
    school_name: institutionSelectedName(document.getElementById('ff-school-sel')?.value, 'ff-school-name'),
    school_street: _v('ff-school-street') || null, school_city: _v('ff-school-city') || null, school_state: _v('ff-school-state') || null,
    grade_level: document.getElementById('ff-grade')?.value || null,
    child_street: _v('ff-street') || null, child_city: _v('ff-city') || null, child_state: _v('ff-state') || null, child_zip: _v('ff-zip') || null,
    parent1_first: _v('ff-p1first') || null, parent1_last: _v('ff-p1last') || null, parent1_phone: normalizePhone(_v('ff-p1phone')) || null, parent1_email: _v('ff-p1email') || null,
    baptism_church: institutionSelectedName(document.getElementById('ff-bchurch-sel')?.value, 'ff-bchurch-name'),
    baptism_city: _v('ff-bcity') || null, baptism_state: _v('ff-bstate') || null, baptism_country: _v('ff-bcountry') || null,
    communion_date: _v('ff-cdate') || null,
    communion_institution_id: churchSel && churchSel !== '__other' ? churchSel : null,
    communion_church_override: churchSel === '__other' ? (_v('ff-church-override') || null) : null,
    // City/State: manual for "Other", else derived from the listed institution.
    ...(() => { const cs = detailsCityState(churchSel, 'ff-ccity', 'ff-cstate'); return { communion_city: cs.city, communion_state: cs.state }; })(),
    documents: _M.docs,
    updated_at: nowIso(),
  };
  return { ok: true, payload, name };
}

// Create modal save.
async function fcSave() {
  const r = _fcReadPayload();
  if (!r.ok) { alert('Student name is required.'); return; }
  const { payload, name } = r;
  if (_M.isEdit) { const res = await _fcWriteEdit(_M.id, r); if (res.ok) { window.flashSavedThen(() => { fcCloseModal(); refreshActivePanel(); }); } return; }
  payload.status_code = 'enrolled';
  payload.archived = false;
  payload.timeline = [{ type: 'auto', text: 'File opened', created_at: nowIso() }];
  const { data: ins, error } = await insertWithRetry('sacramental_firstcomm', payload);
  if (error) { reportWriteError('firstcomm insert', error); return; }
  // Apply the pending "Link Family Member" pick via the shared rule (mint/join).
  const pend = getPendingAdd('firstcomm');
  if (pend && ins?.id) { await familyLink('firstcomm', ins.id, pend.id); clearPendingAdd('firstcomm'); }
  logActivity({ action: 'added First Communion student', entityType: 'firstcomm', entityName: name, contextType: 'firstcomm' });
  const { data: { user } } = await sb.auth.getUser();
  const uids = await getUserIdsForSacrament('first_communion');
  notifyUsers(uids, user?.id, `New First Communion student added: ${name}`, 'info', 'firstcomm');
  window.flashSavedThen(async () => { fcCloseModal(); await loadFcData(); refreshActivePanel(); });
}

// Shared edit writer (status/archive/timeline) used by modal + shell.
async function _fcWriteEdit(id, r) {
  const { payload, name } = r;
  const prior = allFc.find(x => x.id === id);
  const newStatus = document.getElementById('ff-status')?.value || statusOf(prior);
  payload.status_code = newStatus;
  payload.archived = _chk('ff-archive');
  const tl = JSON.parse(JSON.stringify(prior?.timeline || []));
  if (prior && statusOf(prior) !== 'received' && newStatus === 'received') tl.push({ type: 'auto', text: 'First Communion Received', created_at: nowIso() });
  payload.timeline = tl;
  const { error } = await withWriteRetry(() => sb.from('sacramental_firstcomm').update(payload).eq('id', id), { kind: 'update' });
  if (error) { reportWriteError('firstcomm update', error); return { ok: false }; }
  logActivity({ action: 'updated First Communion record', entityType: 'firstcomm', entityName: name, contextType: 'firstcomm', contextId: id });
  await loadFcData();
  return { ok: true };
}

// ── Shell config hooks (inline edit form + save/delete/bulk) ─────────────────
// Inline edit form for the shell detail pane: reuse the exact form markup, but
// skip the modal-title + modal-actions (the shell renders Save/Cancel/Delete).
export function buildFcEditForm(p) {
  _M = newModalState(p);
  const html = buildModalHtml(p, { inline: true });
  setTimeout(() => _hydrate(), 0);   // render docs + family chip after mount
  return html;
}
export async function fcSaveEdit(id) {
  const r = _fcReadPayload();
  if (!r.ok) { alert('Student name is required.'); return { ok: false }; }
  return _fcWriteEdit(id, r);
}
export async function fcDeleteRec(id) {
  if (!confirm('Permanently delete this record? This cannot be undone.')) return { ok: false };
  // Capture the display name BEFORE deletion — the record is gone afterward.
  const _name = allFc.find(x => x.id === id)?.name || 'First Communion record';
  const { error } = await deleteWithRetry(() => sb.from('sacramental_firstcomm').delete().eq('id', id));
  if (error) { alert('Delete failed: ' + error.message); return { ok: false }; }
  allFc = allFc.filter(x => x.id !== id);
  logActivity({ action: 'deleted First Communion record', entityType: 'firstcomm', entityName: _name, contextType: 'firstcomm' });
  updateStats();
  return { ok: true };
}
export async function fcBulkStatus(ids, status) {
  for (const id of ids) {
    const { error } = await sb.from('sacramental_firstcomm').update({ status_code: status, updated_at: nowIso() }).eq('id', id);
    if (error) { alert('Bulk update failed: ' + error.message); return { ok: false }; }
    const p = allFc.find(x => x.id === id); if (p) p.status_code = status;
  }
  logActivity({ action: 'bulk-updated First Communion status', entityType: 'firstcomm', entityName: `${ids.length} files`, contextType: 'firstcomm' });
  updateStats();
  return { ok: true };
}
async function fcDeletePerson(id) {
  if (!confirm('Permanently delete this record? This cannot be undone.')) return;
  const { error } = await deleteWithRetry(() => sb.from('sacramental_firstcomm').delete().eq('id', id));
  if (error) { alert('Delete failed: ' + error.message); return; }
  fcCloseModal(); await loadFcData(); refreshActivePanel();
}

// ── Cohort manager — shared module (src/sacramental/cohortManager.js) ─────────
registerCohortManager({
  panel: 'firstcomm', idPrefix: 'fcoh', dateLabel: 'First Communion Date', stateLabel: 'State',
  noun: 'student', pluralNoun: 'students', deleteNote: 'Students keep their data but lose the cohort link.',
  coordinatorNames: () => _fcCoordinatorNames,
  getCohorts: () => _cohorts, getRecords: () => allFc,
  open: (html) => _fcOpen(html), close: () => fcCloseModal(),
  reloadCohorts: () => loadCohorts(), refresh: () => refreshActivePanel(),
});

// ── Template ─────────────────────────────────────────────────────────────────
let _tplState = null, _tplRowId = null;
async function openFcTemplate() {
  const { data } = await sb.from('firstcomm_templates').select('*').limit(1);
  _tplRowId = data?.[0]?.id || null;
  _tplState = (data?.[0]?.documents) ? JSON.parse(JSON.stringify(data[0].documents)) : JSON.parse(JSON.stringify(_tplDocs));
  _fcOpen(buildTplHtml());
}
function buildTplHtml() {
  return `<div class="modal-title">First Communion Template</div>
    ${_sectionHead('Documents')}
    <div style="font-size:12px;color:#6B7280;margin-bottom:8px;">🔒 Locked documents are required and cannot be removed.</div>
    <div id="fc-tpl-docs">${renderTplDocs()}</div>
    <div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="fc-tpl-new" placeholder="Add document…" style="flex:1;border-radius:6px;border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();fcTplAdd();}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="fcTplAdd()">+ Add</button></div>
    <div style="font-size:12px;color:#6B7280;font-style:italic;margin-top:1rem;">Changes apply to new files only.</div>
    <div class="modal-actions"><button class="btn-secondary" onclick="fcCloseModal()">Cancel</button><button class="btn-primary" onclick="fcTplSave()">Save Template</button></div>`;
}
function renderTplDocs() { return (_tplState || []).map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;"><span style="flex:1;font-size:13px;">${_esc(d.name)}</span>${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;"></i>` : `<button onclick="fcTplRemove(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:14px;">×</button>`}</div>`).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No documents.</div>`; }
function fcTplAdd() { const inp = document.getElementById('fc-tpl-new'); const n = (inp?.value || '').trim(); if (!n) return; _tplState.push({ name: n, deletable: true }); inp.value = ''; document.getElementById('fc-tpl-docs').innerHTML = renderTplDocs(); }
function fcTplRemove(i) { _tplState.splice(i, 1); document.getElementById('fc-tpl-docs').innerHTML = renderTplDocs(); }
async function fcTplSave() {
  const payload = { documents: _tplState, updated_at: nowIso() };
  let error;
  if (_tplRowId) { ({ error } = await sb.from('firstcomm_templates').update(payload).eq('id', _tplRowId)); }
  else { ({ error } = await sb.from('firstcomm_templates').insert(payload)); }
  if (error) { alert('Save failed: ' + error.message); return; }
  _tplDocs = _tplState;
  window.flashSaved();   // shared green "Saved ✓" confirmation
}

Object.assign(window, {
  loadFirstComm, expandFirstComm,
  openFcCreate, openFcEdit, openFcTemplate, fcCloseModal,
  toggleFcDoc, addFcNote, fcEditNote,
  fcCohortPick, fcDobChange, fcChurchChange, fcSchoolChange, fcBaptismChange,
  fcDocReceived, fcRemoveDoc, fcAddDoc,
  fcSave, fcDeletePerson,
  fcTplAdd, fcTplRemove, fcTplSave,
});
