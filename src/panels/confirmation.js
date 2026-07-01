import { sb, withWriteRetry, serializeWrite, insertWithRetry, deleteWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, formatDateDisplay, todayCST, logActivity, reportWriteError, applyDocCheck, docCheckStampHtml } from '../utils.js';
import { isAdmin, canAccessSacrament, isSacramentCoordinator, accessibleParishesForSacrament } from '../roles.js';
import { notifyUsers, getUserIdsForSacrament, notifySacramentEvent } from '../notifications.js';
import { formatPhone, normalizePhone } from '../utils/phone.js';
import { renderSacramentalPanel, refreshActivePanel, openSacramentalRecord, getSelectedParish } from '../sacramental/panelShell.js';
import { shouldShowParishField, parishCreateFieldHtml, resolveCreateParish, parishFieldValid, shouldShowParishFieldEdit, parishEditFieldHtml, readEditParish } from '../sacramental/parishCreateField.js';
import { editNoteLog } from '../sacramental/noteEdit.js';
import { sealGuardConfirm } from '../ui/sealGuard.js';
import { buildPreparerField, readPreparerValue } from '../sacramental/preparerField.js';
import { registerFamilyPanel, familyAddPickerHtml, getPendingAdd, clearPendingAdd, familyLink } from '../sacramental/familyLink.js';
import { detailsChurchToggle, detailsCityState, inheritCohortChurch, inheritCohortFormation,
  institutionAddressAutofill, institutionOptionsHtml, institutionSelectedName, institutionAddressSync } from '../sacramental/churchLocation.js';
import { registerCohortManager } from '../sacramental/cohortManager.js';

const CONF_STATUS = {
  enrolled:    { label:'Enrolled',       color:'#4A1D96', bg:'#EDE9FE', dot:'#7C3AED' },  // purple
  preparation: { label:'In Preparation', color:'#7D6608', bg:'#FEF9E7', dot:'#D4AC0D' },  // yellow
  complete:    { label:'Complete',       color:'#2D6A4F', bg:'#D8F3DC', dot:'#2D6A4F' },  // green
  inactive:    { label:'Inactive',       color:'#616A6B', bg:'#F2F3F4', dot:'#AAB7B8' },  // grey
};
const COUNTRIES = ['United States of America', 'Mexico', 'Philippines', 'Vietnam', 'Nigeria', 'India', 'Other'];
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
const FALLBACK_TEMPLATES = {
  youth: { documents: [{ name: 'Baptismal Certificate', deletable: false }, { name: 'Petition to Bishop', deletable: true }], service_hours_enabled: false, service_hours_required: 20 },
  adult: { documents: [{ name: 'Baptismal Certificate', deletable: false }, { name: 'Petition to Bishop', deletable: true }], service_hours_enabled: false, service_hours_required: 20 },
};

let allConf = [], confFilter = 'all', confExpanded = null, _cohortFilter = 'all';
let _cohorts = [], _templates = {}, _M = null, _confCoordinatorNames = [];

function fullAccess() { return isAdmin() || canAccessSacrament('confirmation'); }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _curUserName() { return store.currentUserProfile?.personnel?.name || 'Staff'; }
function nowIso() { return new Date().toISOString(); }
function ageOf(dob) { if (!dob) return null; const d = new Date(dob); if (isNaN(d)) return null; const now = new Date(new Date().toLocaleString('en-US', { timeZone: store.parishSettings?.timezone || 'America/Chicago' })); let a = now.getFullYear() - d.getFullYear(); const m = now.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--; return a; }
function cohortLabel(dateStr) { if (!dateStr) return 'No date'; const d = new Date(dateStr + 'T00:00:00'); return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }

// ── Field accessors (backward-compatible) ────────────────────────────────────
function nameOf(p) { return (p.first_name || p.last_name) ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : (p.name || '—'); }
function lastNameOf(p) { if (p.last_name) return p.last_name; const parts = (p.name || '').trim().split(/\s+/); return parts[parts.length - 1] || ''; }
function statusOf(p) { return p.status_code || 'enrolled'; }
function tmplType(p) { return p.template_type || 'youth'; }
function confDate(p) { return p ? (p.confirmation_date || p.sacrament_date || null) : null; }
function normDocs(p) { return (p.documents || []).map(d => ({ name: d.name, received: d.received ?? d.done ?? false, deletable: d.deletable ?? !d.auto, auto: !!d.auto, checked_on: d.checked_on || null })); }
function notesOf(p) {
  const out = (Array.isArray(p.notes_log) ? p.notes_log : []).map(n => ({ note: n.note || '', by: n.by || null, created_at: n.created_at || null }));
  if (p.notes && String(p.notes).trim()) out.push({ note: String(p.notes).trim(), by: null, created_at: null, legacy: true });
  return out;
}
function svcEnabled(p) { return (p.service_hours_required || 0) > 0; }
function svcIncomplete(p) { return svcEnabled(p) && (p.service_hours_completed || 0) < p.service_hours_required; }

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadTemplates() {
  const { data, error } = await sb.from('confirmation_templates').select('*');
  _templates = {};
  if (!error && data) data.forEach(r => { _templates[r.template_type] = { documents: r.documents || [], service_hours_enabled: !!r.service_hours_enabled, service_hours_required: r.service_hours_required || 20 }; });
  ['youth', 'adult'].forEach(k => { if (!_templates[k]) _templates[k] = JSON.parse(JSON.stringify(FALLBACK_TEMPLATES[k])); });
}
async function loadCohorts() {
  const { data } = await sb.from('sacramental_cohorts').select('*').eq('panel', 'confirmation').order('cohort_date', { ascending: false });
  _cohorts = data || [];
}
async function loadConfCoordinator() {
  try {
    const { data } = await sb.from('program_coordinators').select('coordinator_ids').eq('program', 'confirmation').eq('parish_id', store.parishSettings?.id).maybeSingle();
    _confCoordinatorNames = (data?.coordinator_ids || []).map(pid => (store.personnel || []).find(p => p.id === pid)?.name).filter(Boolean);
  } catch (_) { _confCoordinatorNames = []; }
}

// Data-only refresh (used by the shell + autosave). Returns the record list.
export async function loadConfData() {
  await Promise.all([loadTemplates(), loadCohorts(), loadConfCoordinator()]);
  // Parish-scope: fetch the UNION of parishes this user can access; the in-panel switcher
  // filters per-tab client-side. Single-parish → [home] (≡ old .eq). Fallback to the home
  // parish when the group list is empty (no-group / unresolved).
  const ids = accessibleParishesForSacrament(['confirmation']).map(p => p.id);
  let _q = sb.from('sacramental_confirmation').select('*').order('created_at', { ascending: false });
  if (ids.length) _q = _q.in('parish_id', ids);
  else if (store.parishSettings?.id) _q = _q.eq('parish_id', store.parishSettings.id);
  const { data, error } = await _q;
  if (error) { console.error('[confirmation]', error); return []; }
  allConf = data || [];
  store.allConfirmation = allConf;
  updateStats();
  return allConf;
}

// Nav loader — fetch then mount the master-detail shell into #confirmation-root.
export async function loadConfirmation() {
  await loadConfData();
  const root = document.getElementById('confirmation-root');
  if (!root) return;
  const { confirmationConfig } = await import('../sacramental/confirmationConfig.js');
  renderSacramentalPanel(root, confirmationConfig);
}

// ── Shell accessors (consumed by confirmationConfig) ─────────────────────────
export function getConfRecords() { return allConf; }
export function getConfRecord(id) { return allConf.find(x => x.id === id) || null; }
export { fullAccess as confCanManage };
export { CONF_STATUS, nameOf, lastNameOf, statusOf, tmplType, confDate, normDocs, notesOf, ageOf, svcEnabled, svcIncomplete };

// Register with the shared family-link mechanism — same mechanism as First Communion,
// just a different table. Applies to ALL candidates (youth and adult; no type gate).
registerFamilyPanel('confirmation', {
  table: 'sacramental_confirmation',
  nameOf: (r) => nameOf(r),
  getAll: () => allConf,
  refresh: async () => { await loadConfData(); refreshActivePanel(); },
  canManage: () => fullAccess(),
  noun: 'candidate',
});
export function isYouth(p) { return tmplType(p) === 'youth'; }
export function cohortKeyOf(p) { return p?.cohort_id || null; }
export function cohortName(cohortId) {
  if (!cohortId) return 'No Cohort';
  const coh = _cohorts.find(c => c.id === cohortId);
  return cohortLabel(coh?.cohort_date) + (cohortChurchName(coh) ? ` · ${cohortChurchName(coh)}` : '');
}
export function cohortDateOf(cohortId) { return _cohorts.find(c => c.id === cohortId)?.cohort_date || ''; }
export function preparerOf(p) { return p?.preparer || ''; }
export function confChurch(p) {
  if (p?.confirmation_institution_id) return (store.institutions || []).find(x => x.id === p.confirmation_institution_id)?.name || '';
  return p?.confirmation_location || '';
}
function updateStats() {
  const active = allConf.filter(p => !p.archived && statusOf(p) !== 'inactive');
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('stat-con-total', active.length);
  set('stat-con-upcoming', active.filter(p => confDate(p) && confDate(p) >= todayCST()).length);
  set('stat-con-docs', active.filter(p => normDocs(p).some(d => !d.received)).length);
}

function cohortChurchName(coh) {
  if (!coh) return '';
  if (coh.church_institution_id) { const i = (store.institutions || []).find(x => x.id === coh.church_institution_id); if (i) return i.name; }
  return coh.church_override || '';
}
// ── Autosave ─────────────────────────────────────────────────────────────────
async function _patch(id, patch) { const p = allConf.find(x => x.id === id); if (!p) return null; const { error } = await serializeWrite(`confirmation:${id}`, () => withWriteRetry(() => sb.from('sacramental_confirmation').update({ ...patch, updated_at: nowIso() }).eq('id', id), { kind: 'update' })); if (error) { alert('Save failed: ' + error.message); return null; } Object.assign(p, patch); return p; }
async function toggleConfDoc(id, i) {
  const p = allConf.find(x => x.id === id); if (!p) return;
  const docs = normDocs(p); applyDocCheck(docs[i], !docs[i].received);
  const prevAll = normDocs(p).length > 0 && normDocs(p).every(d => d.received);
  const allDone = docs.length > 0 && docs.every(d => d.received);
  const patch = { documents: docs };
  if (allDone && !prevAll) { const tl = JSON.parse(JSON.stringify(p.timeline || [])); tl.push({ type: 'auto', text: 'All documents received', created_at: nowIso() }); patch.timeline = tl; }
  if (await _patch(id, patch)) { updateStats(); refreshActivePanel(); }
}
async function addConfNote(id) {
  const inp = document.getElementById('cfn-' + id); const note = (inp?.value || '').trim(); if (!note) return;
  const p = allConf.find(x => x.id === id); if (!p) return;
  if (!(await sealGuardConfirm(note))) return;   // shared seal-of-confession guard on the note
  const log = Array.isArray(p.notes_log) ? JSON.parse(JSON.stringify(p.notes_log)) : [];
  log.push({ note, by: _curUserName(), created_at: nowIso() });
  if (await _patch(id, { notes_log: log })) window.flashSavedThen(() => refreshActivePanel());
}
// Edit a notes_log note in place (shared shape): overwrite text + stamp edited_at.
async function confEditNote(id, idx) {
  const p = allConf.find(x => x.id === id); if (!p) return;
  const log = editNoteLog(p.notes_log, idx, nowIso);
  if (!log) return;
  if (!(await sealGuardConfirm(log[idx].note))) return;   // shared seal guard on the edited note
  if (await _patch(id, { notes_log: log })) window.flashSavedThen(() => refreshActivePanel());
}

// ── Big modal scaffolding ────────────────────────────────────────────────────
function _confOverlay() {
  let ov = document.getElementById('conf-overlay');
  if (!ov) { ov = document.createElement('div'); ov.id = 'conf-overlay'; ov.className = 'modal-overlay'; ov.innerHTML = `<div class="modal anl-modal"><button class="modal-close" onclick="confCloseModal()">×</button><div id="conf-modal-content"></div></div>`; document.body.appendChild(ov); ov.addEventListener('click', e => { if (e.target === ov) confCloseModal(); }); }
  return ov;
}
function _confOpen(html) { _confOverlay(); document.getElementById('conf-modal-content').innerHTML = html; document.getElementById('conf-overlay').classList.add('open'); }
function confCloseModal() { document.getElementById('conf-overlay')?.classList.remove('open'); _M = null; }

function _row(...cells) { return `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cells.map(c => `<div style="flex:1;min-width:120px;">${c}</div>`).join('')}</div>`; }
function _input(id, label, val = '', type = 'text', extra = '') { return `<label>${label}</label><input type="${type}" id="${id}" value="${_esc(val)}" ${extra} />`; }
function _stateSelect(id, val) { return `<label>State/Province</label><select id="${id}"><option value="">—</option>${US_STATES.map(s => `<option${s === val ? ' selected' : ''}>${s}</option>`).join('')}</select>`; }
function _toggle(id, label, on, onchange = '') { return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:.75rem;"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${onchange ? `onchange="${onchange}"` : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" />${label}</label>`; }
function _sectionHead(t) { return `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--cardinal);margin:1.4rem 0 .5rem;border-bottom:.5px solid var(--stone);padding-bottom:4px;">${t}</div>`; }
// Grade dropdown 2–12, default 2 (out-of-range legacy values preserved as a leading option).
const GRADE_OPTS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'];
function _gradeSelect(id, current) {
  const cur = current || '2';
  const extra = (cur && !GRADE_OPTS.includes(cur)) ? `<option selected>${_esc(cur)}</option>` : '';
  return `<label>Grade Level</label><select id="${id}">${extra}${GRADE_OPTS.map(g => `<option${g === cur ? ' selected' : ''}>${g}</option>`).join('')}</select>`;
}
// Institution dropdown ("— Select —" + institutions + "Other…") for a text-stored
// church/school field; option VALUES are institution ids (for address autofill),
// stored value is the institution NAME, preselected by name match.
function _instSelect(id, name, onchange) {
  const { options, isOther } = institutionOptionsHtml(name);
  return `<select id="${id}" onchange="${onchange}(this.value)"><option value="">— Select —</option>${options}<option value="__other"${isOther ? ' selected' : ''}>Other…</option></select>`;
}

// ── Create / Edit ────────────────────────────────────────────────────────────
async function openConfCreate() {
  clearPendingAdd('confirmation');
  _M = newModalState(null, 'youth');
  _confOpen(buildModalHtml(null)); _hydrate(); confValidateParish();
}
function openConfEdit(id) { const p = allConf.find(x => x.id === id); if (!p) return; _M = newModalState(p, tmplType(p)); _confOpen(buildModalHtml(p)); _hydrate(); }

// Parish-field lockout ONLY: disables Save until a parish is chosen when the create
// parish field is shown; a no-op (Save enabled) otherwise. Other required-field checks
// keep their alert-on-submit behavior.
function confValidateParish() {
  const ok = parishFieldValid(['confirmation'], 'confirmation', 'conf-parish-select');
  const btn = document.getElementById('conf-save');
  if (btn) { btn.disabled = !ok; btn.style.opacity = ok ? '1' : '.5'; btn.style.cursor = ok ? 'pointer' : 'not-allowed'; }
  return ok;
}
function newModalState(p, type) {
  return {
    id: p?.id || null, isEdit: !!p, type,
    docs: p ? normDocs(p) : computeTemplateDocs(type),
  };
}
function computeTemplateDocs(type) { return (_templates[type]?.documents || FALLBACK_TEMPLATES[type].documents).map(d => ({ name: d.name, received: false, deletable: d.deletable ?? true, auto: d.deletable === false })); }
function _nameParts(p) { return { first: p?.first_name || (p?.name || '').split(/\s+/)[0] || '', middle: p?.middle_name || '', last: p?.last_name || (p?.name || '').split(/\s+/).slice(1).join(' ') || '' }; }
function _caseLabel() { return ''; }

function buildModalHtml(p, opts = {}) {
  const inline = !!opts.inline;
  const isEdit = _M.isEdit;
  const np = _nameParts(p);
  const age = ageOf(p?.dob);
  const instOpts = (store.institutions || []).map(i => `<option value="${i.id}"${p?.confirmation_institution_id === i.id ? ' selected' : ''}>${_esc(i.name)}</option>`).join('');
  const cohortOpts = _cohorts.map(c => `<option value="${c.id}"${p?.cohort_id === c.id ? ' selected' : ''}>${cohortLabel(c.cohort_date)}</option>`).join('');
  const isMinor = age !== null && age <= 17;
  const isAdultAge = age !== null && age >= 18;

  let h = inline ? '' : `<div class="modal-title">${isEdit ? 'Edit Confirmation File' : 'New Confirmation Candidate'}</div>`;

  // Parish picker. CREATE (All tab, >1 parish): placeholder + Save-lockout. EDIT (>1
  // parish): the record's parish preselected, reassignable, NO lockout. Distinct ids.
  if ((!isEdit && !inline) && shouldShowParishField(['confirmation'], 'confirmation')) {
    h += parishCreateFieldHtml(['confirmation'], { selectId: 'conf-parish-select', onChange: 'confValidateParish()' });
  } else if (isEdit && shouldShowParishFieldEdit(['confirmation'])) {
    h += parishEditFieldHtml(['confirmation'], { selectId: 'conf-parish-edit', currentParishId: p?.parish_id || null });
  }

  // 1 — Cohort FIRST (SELECT only; created in the panel via Manage Cohorts). Picking it
  // first defaults BOTH the church and the formation person (confCohortPick).
  h += _sectionHead('Cohort');
  if (_cohorts.length) {
    h += `<label>Cohort</label><select id="cf-cohort" onchange="confCohortPick(this.value)"><option value="">— None —</option>${cohortOpts}</select>`;
  } else {
    h += `<label>Cohort</label><select id="cf-cohort" disabled style="color:#9CA3AF;"><option value="">No cohorts yet</option></select>
      <div style="font-size:11.5px;color:#9CA3AF;margin-top:4px;">Create a cohort first via <strong>Manage Cohorts</strong> in the Confirmation panel.</div>`;
  }

  // 2 — Template type
  h += _sectionHead('Template Type');
  h += `<div style="display:flex;gap:10px;"><button type="button" id="ct-youth" class="sac-type-btn${_M.type === 'youth' ? ' active' : ''}" onclick="confSetType('youth')" style="flex:1;">Youth</button><button type="button" id="ct-adult" class="sac-type-btn${_M.type === 'adult' ? ' active' : ''}" onclick="confSetType('adult')" style="flex:1;">Adult</button></div>
    <div id="cf-adult-note" class="anl-info-box" style="display:${_M.type === 'adult' ? 'block' : 'none'};">For adult candidates who are unbaptized, please use the OCIA panel instead.</div>`;

  // 3 — Person responsible for formation (clergy + Confirmation coordinator + Other)
  h += _sectionHead('Person Responsible for Formation');
  h += buildPreparerField('cf-preparer', p?.preparer || '', { coordinatorNames: _confCoordinatorNames, label: 'Person Responsible for Formation' });

  // 4 — Candidate info
  h += _sectionHead('Candidate Information');
  h += _row(_input('cf-first', 'First Name', np.first), _input('cf-middle', 'Middle', np.middle), _input('cf-last', 'Last Name', np.last));
  h += `<label>Date of Birth</label><input type="date" id="cf-dob" value="${(p?.dob && /^\d{4}-\d{2}-\d{2}/.test(p.dob)) ? p.dob.slice(0, 10) : ''}" oninput="confDobChange()" />`;
  h += `<div id="cf-adultage-note" class="anl-info-box" style="display:${isAdultAge ? 'block' : 'none'};">For adult candidates who are unbaptized, please use the OCIA panel instead.</div>`;
  // minor block
  h += `<div id="cf-minor-block" style="display:${isMinor ? 'block' : 'none'};">
    ${_row(`<label>Cell Phone</label><input type="text" id="cf-cell-minor" value="" placeholder="Student is a minor" disabled style="background:#F0EDE8;" />`, _input('cf-email-minor', 'Email', p?.candidate_email || p?.email || ''))}
    ${_row(`<label>School</label>${_instSelect('cf-school-sel', p?.school_name || '', 'confSchoolChange')}`, _gradeSelect('cf-grade', p?.grade_level || p?.grade))}
    <div id="cf-school-other-wrap" style="display:${institutionOptionsHtml(p?.school_name || '').isOther ? 'block' : 'none'};margin-top:6px;">${_input('cf-school-name', 'School name', institutionOptionsHtml(p?.school_name || '').isOther ? (p?.school_name || '') : '')}</div>
    ${_input('cf-school-street', 'School Street Address', p?.school_street || '')}
    ${_row(_input('cf-school-city', 'School City', p?.school_city || ''), _stateSelect('cf-school-state', p?.school_state || ''))}
    ${_sectionHead('Parent / Guardian')}
    ${_input('cf-parent-name', 'Parent/Guardian Name', p?.parent_name || p?.parent1 || '')}
    ${_row(_input('cf-parent-phone', 'Cell Phone', p?.parent_phone || '', 'tel'), _input('cf-parent-email', 'Email', p?.parent_email || ''))}
    ${_toggle('cf-parent-perm', 'Permission Granted', !!p?.parent_permission_granted)}
    ${_input('cf-parent-permdate', 'Date Permission Received', p?.parent_permission_date || '', 'date')}
  </div>`;
  // adult contact block
  h += `<div id="cf-adult-block" style="display:${isMinor ? 'none' : 'block'};">${_row(_input('cf-cell', 'Cell Phone', p?.candidate_phone || p?.phone || '', 'tel'), _input('cf-email', 'Email', p?.candidate_email || p?.email || ''))}</div>`;

  // 5 — Confirmation details
  h += _sectionHead('Confirmation Details');
  h += _input('cf-confname', 'Confirmation Name', p?.confirmation_name || '');
  h += _input('cf-sponsor', 'Sponsor Name', p?.sponsor_name || p?.sponsor || '');
  h += _input('cf-confdate', 'Confirmation Date', confDate(p) || '', 'date');
  h += `<label>Church</label><select id="cf-church" onchange="confChurchChange(this.value)"><option value="">— Select —</option>${instOpts}<option value="__other"${(p?.confirmation_location && !p?.confirmation_institution_id) ? ' selected' : ''}>Other…</option></select>
    <div id="cf-church-other-wrap" style="display:${(p?.confirmation_location && !p?.confirmation_institution_id) ? 'block' : 'none'};">
      ${_input('cf-church-override', 'Church name', p?.confirmation_location || '')}
      ${_row(_input('cf-ccity', 'City', p?.confirmation_city || ''), _stateSelect('cf-cstate', p?.confirmation_state || ''))}
    </div>`;

  // 6 — Baptism — institution dropdown + Other; listed church autofills/greys City/State.
  h += _sectionHead('Baptism Information');
  const cbchName = p?.baptism_church || '';
  h += `<label>Church of Baptism</label>${_instSelect('cf-bchurch-sel', cbchName, 'confBaptismChange')}`;
  h += `<div id="cf-bchurch-other-wrap" style="display:${institutionOptionsHtml(cbchName).isOther ? 'block' : 'none'};margin-top:6px;">${_input('cf-bchurch-name', 'Church name', institutionOptionsHtml(cbchName).isOther ? cbchName : '')}</div>`;
  h += _row(_input('cf-bcity', 'City', p?.baptism_city || ''), _stateSelect('cf-bstate', p?.baptism_state || ''));
  h += `<label>Country</label><select id="cf-bcountry">${COUNTRIES.map(co => `<option${(p?.baptism_country || 'United States of America') === co ? ' selected' : ''}>${co}</option>`).join('')}</select>`;

  // 7 — First communion — institution dropdown + Other; listed church autofills/greys City/State.
  h += _sectionHead('First Communion Information');
  const cfcName = p?.first_communion_church || '';
  h += `<label>Church of First Communion</label>${_instSelect('cf-fcchurch-sel', cfcName, 'confFcChurchChange')}`;
  h += `<div id="cf-fcchurch-other-wrap" style="display:${institutionOptionsHtml(cfcName).isOther ? 'block' : 'none'};margin-top:6px;">${_input('cf-fcchurch-name', 'Church name', institutionOptionsHtml(cfcName).isOther ? cfcName : '')}</div>`;
  h += _row(_input('cf-fccity', 'City', p?.first_communion_city || ''), _stateSelect('cf-fcstate', p?.first_communion_state || ''));
  h += `<label>Country</label><select id="cf-fccountry">${COUNTRIES.map(co => `<option${(p?.first_communion_country || 'United States of America') === co ? ' selected' : ''}>${co}</option>`).join('')}</select>`;

  // 8 — Documents
  h += _sectionHead('Document Checklist');
  h += `<div id="cf-docs"></div><div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="cf-doc-new" placeholder="Add document…" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();confAddDoc();}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="confAddDoc()">+ Add</button></div>`;

  // 9 — Family group (create + edit)
  if (!isEdit) {
    h += _sectionHead('Family');
    h += `<div style="font-size:11.5px;color:#9CA3AF;margin-bottom:6px;">Link this candidate to a sibling already on file — they’ll share one family group.</div>`;
    h += familyAddPickerHtml('confirmation');
  }

  if (isEdit) {
    h += _sectionHead('Status');
    h += `<label>Status</label><select id="cf-status">${Object.entries(CONF_STATUS).map(([k, v]) => `<option value="${k}"${statusOf(p) === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`;
    // Service hours — YOUTH ONLY. Always built in edit mode but display-gated to
    // youth (confSetType toggles it live); the save persists hours only for youth.
    const svcReq = p?.service_hours_required ?? _templates[_M.type]?.service_hours_required ?? 20;
    h += `<div id="cf-svc-section" style="display:${_M.type === 'youth' ? 'block' : 'none'};">
      ${_sectionHead('Service Hours')}
      ${_row(_input('cf-svc-done', 'Hours Completed', String(p?.service_hours_completed ?? 0), 'number'), `<label>Hours Required</label><input type="number" value="${svcReq}" readonly style="background:#F0EDE8;" id="cf-svc-req" />`)}
    </div>`;
    h += _toggle('cf-archive', 'Archive this file', !!p?.archived);
  }

  if (!inline) {
    h += `<div class="modal-actions" style="justify-content:space-between;">
      ${isEdit ? `<button class="btn-delete" onclick="confDeletePerson('${_M.id}')">Delete</button>` : '<span></span>'}
      <div style="display:flex;gap:8px;"><button class="btn-secondary" onclick="confCloseModal()">Cancel</button><button class="btn-primary" id="conf-save" onclick="confSave()">${isEdit ? 'Save' : 'Create File'}</button></div>
    </div>`;
  }
  return h;
}

function _hydrate() {
  renderModalDocs();
  // Lock+fill address for any preselected listed institution (onchange fires only on
  // user change). No-op for "Other"/none. School fields exist only in the minor block.
  institutionAddressSync('cf-school-sel', { street: 'cf-school-street', city: 'cf-school-city', state: 'cf-school-state' });
  institutionAddressSync('cf-bchurch-sel', { city: 'cf-bcity', state: 'cf-bstate' });
  institutionAddressSync('cf-fcchurch-sel', { city: 'cf-fccity', state: 'cf-fcstate' });
}
function confSchoolChange(v) {
  const wrap = document.getElementById('cf-school-other-wrap'); if (wrap) wrap.style.display = v === '__other' ? 'block' : 'none';
  institutionAddressAutofill(v, { street: 'cf-school-street', city: 'cf-school-city', state: 'cf-school-state' });
}
function confBaptismChange(v) {
  const wrap = document.getElementById('cf-bchurch-other-wrap'); if (wrap) wrap.style.display = v === '__other' ? 'block' : 'none';
  institutionAddressAutofill(v, { city: 'cf-bcity', state: 'cf-bstate' });
}
function confFcChurchChange(v) {
  const wrap = document.getElementById('cf-fcchurch-other-wrap'); if (wrap) wrap.style.display = v === '__other' ? 'block' : 'none';
  institutionAddressAutofill(v, { city: 'cf-fccity', state: 'cf-fcstate' });
}
function renderModalDocs() {
  const el = document.getElementById('cf-docs'); if (!el) return;
  el.innerHTML = _M.docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
    <input type="checkbox" ${d.received ? 'checked' : ''} onchange="confDocReceived(${i},this.checked)" style="width:15px;height:15px;accent-color:var(--cardinal);" />
    <span style="font-size:13px;color:var(--navy);">${_esc(d.name)}</span>
    ${docCheckStampHtml(d)}
    ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;margin-left:8px;" title="Required"></i>` : `<button onclick="confRemoveDoc(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;margin-left:8px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>`}
  </div>`).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No documents.</div>`;
}

// modal handlers
function confSetType(t) {
  _M.type = t;
  document.getElementById('ct-youth').classList.toggle('active', t === 'youth');
  document.getElementById('ct-adult').classList.toggle('active', t === 'adult');
  document.getElementById('cf-adult-note').style.display = t === 'adult' ? 'block' : 'none';
  const svc = document.getElementById('cf-svc-section');   // service hours: youth only
  if (svc) svc.style.display = t === 'youth' ? 'block' : 'none';
  if (!_M.isEdit) { _M.docs = computeTemplateDocs(t); renderModalDocs(); }
}
function confCohortPick(v) {
  const coh = _cohorts.find(c => c.id === v);
  if (coh && coh.cohort_date) { const dt = document.getElementById('cf-confdate'); if (dt && !dt.value) dt.value = coh.cohort_date; }
  inheritCohortChurch(coh, 'cf');             // default (editable) the church to the cohort's
  inheritCohortFormation(coh, 'cf-preparer'); // default (editable) the formation person too
}
function confDobChange() {
  const age = ageOf(document.getElementById('cf-dob').value);
  const minor = age !== null && age <= 17, adultAge = age !== null && age >= 18;
  document.getElementById('cf-minor-block').style.display = minor ? 'block' : 'none';
  document.getElementById('cf-adult-block').style.display = minor ? 'none' : 'block';
  document.getElementById('cf-adultage-note').style.display = adultAge ? 'block' : 'none';
}
function confChurchChange(v) { detailsChurchToggle(v, 'cf'); }
function confDocReceived(i, v) { applyDocCheck(_M.docs[i], v); renderModalDocs(); }
function confRemoveDoc(i) { _M.docs.splice(i, 1); renderModalDocs(); }
function confAddDoc() { const inp = document.getElementById('cf-doc-new'); const name = (inp?.value || '').trim(); if (!name) return; _M.docs.push({ name, received: false, deletable: true, auto: false }); inp.value = ''; renderModalDocs(); }

// ── Save ─────────────────────────────────────────────────────────────────────
function _v(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function _chk(id) { return !!document.getElementById(id)?.checked; }
// Shared DOM→payload reader, used by the create modal AND the shell inline edit.
function _confReadPayload() {
  const first = _v('cf-first'), last = _v('cf-last');
  const name = [first, _v('cf-middle'), last].filter(Boolean).join(' ');
  if (!name) return { ok: false };
  const type = _M.type;
  const age = ageOf(_v('cf-dob'));
  const minor = age !== null && age <= 17;
  const cohortSel = document.getElementById('cf-cohort')?.value || '';
  const coh = _cohorts.find(c => c.id === cohortSel);
  const churchSel = document.getElementById('cf-church')?.value || '';

  const tmpl = _templates[type] || FALLBACK_TEMPLATES[type];
  const payload = {
    name, first_name: first || null, middle_name: _v('cf-middle') || null, last_name: last || null,
    template_type: type, dob: _v('cf-dob') || null,
    cohort_id: cohortSel || null, cohort_date: coh?.cohort_date || null,
    preparer: readPreparerValue('cf-preparer'),
    candidate_phone: minor ? null : (normalizePhone(_v('cf-cell')) || null),
    candidate_email: minor ? (_v('cf-email-minor') || null) : (_v('cf-email') || null),
    school_name: minor ? institutionSelectedName(document.getElementById('cf-school-sel')?.value, 'cf-school-name') : null,
    school_street: minor ? (_v('cf-school-street') || null) : null,
    school_city:   minor ? (_v('cf-school-city') || null) : null,
    school_state:  minor ? (_v('cf-school-state') || null) : null,
    grade_level: minor ? (document.getElementById('cf-grade')?.value || null) : null,
    parent_name: minor ? (_v('cf-parent-name') || null) : null,
    parent_phone: minor ? (normalizePhone(_v('cf-parent-phone')) || null) : null,
    parent_email: minor ? (_v('cf-parent-email') || null) : null,
    parent_permission_granted: minor ? _chk('cf-parent-perm') : false,
    parent_permission_date: minor ? (_v('cf-parent-permdate') || null) : null,
    confirmation_name: _v('cf-confname') || null,
    sponsor_name: _v('cf-sponsor') || null,
    confirmation_date: _v('cf-confdate') || null,
    confirmation_institution_id: churchSel && churchSel !== '__other' ? churchSel : null,
    confirmation_location: churchSel === '__other' ? (_v('cf-church-override') || null) : (churchSel && churchSel !== '__other' ? ((store.institutions || []).find(i => i.id === churchSel)?.name || null) : null),
    // City/State: manual for "Other", else derived from the listed institution.
    ...(() => { const cs = detailsCityState(churchSel, 'cf-ccity', 'cf-cstate'); return { confirmation_city: cs.city, confirmation_state: cs.state }; })(),
    baptism_church: institutionSelectedName(document.getElementById('cf-bchurch-sel')?.value, 'cf-bchurch-name'),
    baptism_city: _v('cf-bcity') || null, baptism_state: _v('cf-bstate') || null, baptism_country: _v('cf-bcountry') || null,
    first_communion_church: institutionSelectedName(document.getElementById('cf-fcchurch-sel')?.value, 'cf-fcchurch-name'),
    first_communion_city: _v('cf-fccity') || null, first_communion_state: _v('cf-fcstate') || null, first_communion_country: _v('cf-fccountry') || null,
    documents: _M.docs,
    updated_at: nowIso(),
  };
  return { ok: true, payload, name, type, tmpl };
}

// Shared edit writer (status/archive/timeline + youth-only service hours).
async function _confWriteEdit(id, r) {
  const { payload, name, type } = r;
  const prior = allConf.find(x => x.id === id);
  const newStatus = document.getElementById('cf-status')?.value || statusOf(prior);
  payload.status_code = newStatus;
  payload.archived = _chk('cf-archive');
  // Service hours persist for YOUTH ONLY; adults are zeroed out (hidden everywhere).
  if (type === 'youth' && document.getElementById('cf-svc-done')) {
    payload.service_hours_completed = parseInt(_v('cf-svc-done')) || 0;
    payload.service_hours_required = parseInt(document.getElementById('cf-svc-req')?.value) || 0;
  } else if (type === 'adult') {
    payload.service_hours_required = 0; payload.service_hours_completed = 0;
  }
  const tl = JSON.parse(JSON.stringify(prior?.timeline || []));
  if (prior && statusOf(prior) !== 'confirmed' && newStatus === 'confirmed') tl.push({ type: 'auto', text: 'Confirmed', created_at: nowIso() });
  payload.timeline = tl;
  const _ep = readEditParish('conf-parish-edit'); if (_ep) payload.parish_id = _ep;   // parish reassignment (edit field shown)
  const priorStatus = prior ? statusOf(prior) : null;
  const { error } = await withWriteRetry(() => sb.from('sacramental_confirmation').update(payload).eq('id', id), { kind: 'update' });
  if (error) { reportWriteError('confirmation update', error); return { ok: false }; }
  logActivity({ action: 'updated Confirmation record', entityType: 'confirmation', entityName: name, contextType: 'confirmation', contextId: id });
  // Notify on TRANSITION into Complete (terminal fire-state). Not cross-linkable.
  if (priorStatus !== 'complete' && newStatus === 'complete') {
    const { data: { user } } = await sb.auth.getUser();
    notifySacramentEvent({
      keys: ['confirmation'], parishId: payload.parish_id ?? prior?.parish_id ?? null, actorUserId: user?.id,   // route to the record's CURRENT parish (handles reassignment)
      message: `${name} Confirmation — marked complete`, type: 'success', module: 'confirmation', record_id: id,
    });
  }
  await loadConfData();
  return { ok: true };
}

// Create modal save.
async function confSave() {
  const r = _confReadPayload();
  if (!r.ok) { alert('Candidate name is required.'); return; }
  if (_M.isEdit) { const res = await _confWriteEdit(_M.id, r); if (res.ok) { window.flashSavedThen(() => { confCloseModal(); refreshActivePanel(); }); } return; }
  const { payload, name, type, tmpl } = r;
  payload.status_code = 'enrolled';
  payload.archived = false;
  payload.service_hours_required = (type === 'youth' && tmpl.service_hours_enabled) ? (tmpl.service_hours_required || 20) : 0;
  payload.service_hours_completed = 0;
  payload.timeline = [{ type: 'auto', text: 'File opened', created_at: nowIso() }];
  payload.parish_id = resolveCreateParish(['confirmation'], 'confirmation', 'conf-parish-select');   // field value / active tab / single parish
  if (!payload.parish_id) { alert('Please select a parish for this record.'); return; }   // safety floor (lockout already prevents this)
  const { data: ins, error } = await insertWithRetry('sacramental_confirmation', payload);
  if (error) { reportWriteError('confirmation insert', error); return; }
  const pend = getPendingAdd('confirmation');
  if (pend && ins?.id) { await familyLink('confirmation', ins.id, pend.id); clearPendingAdd('confirmation'); }
  logActivity({ action: 'added Confirmation candidate', entityType: 'confirmation', entityName: name, contextType: 'confirmation' });
  const { data: { user } } = await sb.auth.getUser();
  const uids = await getUserIdsForSacrament('confirmation', payload.parish_id ?? null);   // route to the NEW record's parish, not the admin's home
  notifyUsers(uids, user?.id, `New Confirmation candidate added: ${name}`, 'info', 'confirmation');
  window.flashSavedThen(async () => { confCloseModal(); await loadConfData(); refreshActivePanel(); });
}

// ── Shell config hooks (inline edit form + save/delete/bulk) ─────────────────
export function buildConfEditForm(p) {
  _M = newModalState(p, tmplType(p));
  const html = buildModalHtml(p, { inline: true });
  setTimeout(() => _hydrate(), 0);
  return html;
}
export async function confSaveEdit(id) {
  const r = _confReadPayload();
  if (!r.ok) { alert('Candidate name is required.'); return { ok: false }; }
  return _confWriteEdit(id, r);
}
export async function confDeleteRec(id) {
  if (!confirm('Permanently delete this record? This cannot be undone.')) return { ok: false };
  // Capture the display name BEFORE deletion — the record is gone afterward.
  const _name = allConf.find(x => x.id === id)?.name || 'Confirmation record';
  const { error } = await deleteWithRetry(() => sb.from('sacramental_confirmation').delete().eq('id', id));
  if (error) { reportWriteError('confirmation delete', error); return { ok: false }; }
  allConf = allConf.filter(x => x.id !== id);
  logActivity({ action: 'deleted Confirmation record', entityType: 'confirmation', entityName: _name, contextType: 'confirmation' });
  updateStats();
  return { ok: true };
}
export async function confBulkStatus(ids, status) {
  for (const id of ids) {
    const { error } = await sb.from('sacramental_confirmation').update({ status_code: status, updated_at: nowIso() }).eq('id', id);
    if (error) { reportWriteError('confirmation bulk', error); return { ok: false }; }
    const p = allConf.find(x => x.id === id); if (p) p.status_code = status;
  }
  logActivity({ action: 'bulk-updated Confirmation status', entityType: 'confirmation', entityName: `${ids.length} files`, contextType: 'confirmation' });
  updateStats();
  return { ok: true };
}

async function confDeletePerson(id) {
  if (!confirm('Permanently delete this record? This cannot be undone.')) return;
  const { error } = await deleteWithRetry(() => sb.from('sacramental_confirmation').delete().eq('id', id));
  if (error) { alert('Delete failed: ' + error.message); return; }
  confCloseModal(); await loadConfData(); refreshActivePanel();
}

// ── Cohort manager — shared module (src/sacramental/cohortManager.js) ─────────
registerCohortManager({
  panel: 'confirmation', idPrefix: 'coh', dateLabel: 'Confirmation Date', stateLabel: 'State/Province',
  noun: 'candidate', pluralNoun: 'candidates', deleteNote: 'Candidates keep their data but lose the cohort link.',
  coordinatorNames: () => _confCoordinatorNames,
  getCohorts: () => _cohorts, getRecords: () => allConf,
  open: (html) => _confOpen(html), close: () => confCloseModal(),
  reloadCohorts: () => loadCohorts(), refresh: () => refreshActivePanel(),
});

// ── Templates ────────────────────────────────────────────────────────────────
let _tplState = null, _tplActive = 'youth';
function openConfTemplates() { _tplState = JSON.parse(JSON.stringify(_templates)); _tplActive = 'youth'; _confOpen(buildTplHtml()); renderTplBody(); }
function buildTplHtml() {
  const tabs = [['youth', 'Youth'], ['adult', 'Adult']].map(([v, l]) => `<button class="anl-tpl-tab${_tplActive === v ? ' active' : ''}" data-v="${v}" onclick="confTplTab('${v}')">${l}</button>`).join('');
  return `<div class="modal-title">Confirmation Templates</div>
    <div style="display:flex;gap:4px;margin-bottom:1rem;border-bottom:.5px solid var(--stone);padding-bottom:8px;">${tabs}</div>
    <div id="conf-tpl-body"></div>
    <div style="font-size:12px;color:#6B7280;font-style:italic;margin-top:1rem;">Changes apply to new files only.</div>
    <div class="modal-actions"><button class="btn-secondary" onclick="confCloseModal()">Cancel</button><button class="btn-primary" onclick="confTplSave()">Save Template</button></div>`;
}
function _tpl() { _tplState[_tplActive] = _tplState[_tplActive] || { documents: [], service_hours_enabled: false, service_hours_required: 20 }; return _tplState[_tplActive]; }
function renderTplBody() {
  const el = document.getElementById('conf-tpl-body'); if (!el) return;
  const t = _tpl();
  el.innerHTML = `${_sectionHead('Documents')}
    <div style="font-size:12px;color:#6B7280;margin-bottom:8px;">🔒 Locked documents are required and cannot be removed.</div>
    <div id="conf-tpl-docs">${(t.documents || []).map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;"><span style="flex:1;font-size:13px;">${_esc(d.name)}</span>${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;"></i>` : `<button onclick="confTplRemove(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:14px;">×</button>`}</div>`).join('') || '<div style="font-size:12px;color:#9CA3AF;font-style:italic;">None.</div>'}</div>
    <div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="conf-tpl-new" placeholder="Add document…" style="flex:1;border-radius:6px;border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();confTplAdd();}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="confTplAdd()">+ Add</button></div>
    ${_sectionHead('Service Hours')}
    ${_toggle('conf-tpl-svc', 'Service hours required', t.service_hours_enabled, 'confTplSvcToggle()')}
    <div id="conf-tpl-svc-req" style="display:${t.service_hours_enabled ? 'block' : 'none'};">${_input('conf-tpl-svc-amt', 'Required hours', String(t.service_hours_required ?? 20), 'number')}</div>`;
}
function confTplTab(v) { _tplActive = v; document.querySelectorAll('#conf-overlay .anl-tpl-tab').forEach(b => b.classList.toggle('active', b.dataset.v === v)); renderTplBody(); }
function confTplAdd() { const inp = document.getElementById('conf-tpl-new'); const n = (inp?.value || '').trim(); if (!n) return; _tpl().documents.push({ name: n, deletable: true }); renderTplBody(); }
function confTplRemove(i) { _tpl().documents.splice(i, 1); renderTplBody(); }
function confTplSvcToggle() { _tpl().service_hours_enabled = document.getElementById('conf-tpl-svc').checked; document.getElementById('conf-tpl-svc-req').style.display = _tpl().service_hours_enabled ? 'block' : 'none'; }
async function confTplSave() {
  const t = _tpl();
  if (document.getElementById('conf-tpl-svc-amt')) t.service_hours_required = parseInt(document.getElementById('conf-tpl-svc-amt').value) || 20;
  const { error } = await sb.from('confirmation_templates').upsert({ template_type: _tplActive, documents: t.documents, service_hours_enabled: !!t.service_hours_enabled, service_hours_required: t.service_hours_required || 20, updated_at: nowIso() }, { onConflict: 'template_type' });
  if (error) { alert('Save failed: ' + error.message); return; }
  _templates[_tplActive] = JSON.parse(JSON.stringify(t));
  window.flashSaved();   // shared green "Saved ✓" confirmation
}

Object.assign(window, {
  loadConfirmation, expandConfirmation,
  openConfCreate, openConfEdit, openConfTemplates, confCloseModal,
  toggleConfDoc, addConfNote, confEditNote,
  confSetType, confCohortPick, confDobChange, confChurchChange,
  confSchoolChange, confBaptismChange, confFcChurchChange,
  confDocReceived, confRemoveDoc, confAddDoc,
  confSave, confDeletePerson, confValidateParish,
  confTplTab, confTplAdd, confTplRemove, confTplSvcToggle, confTplSave,
});
