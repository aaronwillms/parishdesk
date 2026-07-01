import { sb, withWriteRetry, serializeWrite, insertWithRetry, deleteWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, formatDateDisplay, todayCST, logActivity, reportWriteError } from '../utils.js';
import { isAdmin, canAccessSacrament, isSacramentCoordinator, accessibleParishesForSacrament } from '../roles.js';
import { notifyUsers, getUserIdsForSacrament, notifySacramentEvent } from '../notifications.js';
import { renderSacramentalPanel, refreshActivePanel, openSacramentalRecord, getSelectedParish } from '../sacramental/panelShell.js';
import { shouldShowParishField, parishCreateFieldHtml, resolveCreateParish, parishFieldValid, shouldShowParishFieldEdit, parishEditFieldHtml, readEditParish, initialCreateParish } from '../sacramental/parishCreateField.js';
import { editNoteLog } from '../sacramental/noteEdit.js';
import { buildPreparerField, readPreparerValue } from '../sacramental/preparerField.js';
import { normalizePhone } from '../utils/phone.js';

export const BAP_STATUS = {
  scheduled: { label:'Scheduled', color:'#7D6608', bg:'#FEF9E7', dot:'#D4AC0D' },
  complete:  { label:'Complete',  color:'#2D6A4F', bg:'#D8F3DC', dot:'#2D6A4F' },
  inactive:  { label:'Inactive',  color:'#616A6B', bg:'#F2F3F4', dot:'#AAB7B8' },
};
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

let allBap = [], bapFilter = 'all', bapExpanded = null;
let _tplRow = null, _M = null, _bapCoordinatorNames = [];

// Formation coordinator display names for the "Person Responsible for Formation"
// dropdown (Clergy + coordinator(s) + Other), mirroring the other sacrament panels.
async function loadBapCoordinator() {
  try {
    const { data } = await sb.from('program_coordinators').select('coordinator_ids').eq('program', 'baptism').eq('parish_id', store.parishSettings?.id).maybeSingle();
    _bapCoordinatorNames = (data?.coordinator_ids || []).map(pid => (store.personnel || []).find(p => p.id === pid)?.name).filter(Boolean);
  } catch (_) { _bapCoordinatorNames = []; }
}

function fullAccess() { return isAdmin() || canAccessSacrament('baptism'); }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _curUserName() { return store.currentUserProfile?.personnel?.name || 'Staff'; }
function _curUserId() { return store.currentUserProfile?.user_id || null; }
function nowIso() { return new Date().toISOString(); }
// Parish clergy for the officiant dropdown. Source of truth is the parish-wide
// personnel.clergy boolean (set in the Directory).
function clergyPersonnel() { return (store.personnel || []).filter(p => p.clergy).sort((a, b) => (a.name || '').localeCompare(b.name || '')); }
function ageOf(dob) { if (!dob) return null; const d = new Date(dob); if (isNaN(d)) return null; const now = new Date(new Date().toLocaleString('en-US', { timeZone: store.parishSettings?.timezone || 'America/Chicago' })); let a = now.getFullYear() - d.getFullYear(); const m = now.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--; return a; }

// ── Field accessors (backward-compatible) ────────────────────────────────────
export function nameOf(p) { return (p.first_name || p.last_name) ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : (p.name || '—'); }
export function lastNameOf(p) { if (p.last_name) return p.last_name; const parts = String(p.name || '').trim().split(/\s+/); return parts[parts.length - 1] || ''; }
export function statusOf(p) { return p.status_code || (p.archived ? 'inactive' : 'scheduled'); }
export function bapDate(p) { return p ? (p.baptism_date || p.sacrament_date || null) : null; }
export function dobOf(p) { return p.dob || null; }
export { ageOf as bapAgeOf, _esc as bapEsc };
export function notesOf(p) {
  const out = (Array.isArray(p.notes_log) ? p.notes_log : []).map(n => ({ note: n.note || '', by: n.by || null, created_at: n.created_at || null }));
  if (p.notes && String(p.notes).trim()) out.push({ note: String(p.notes).trim(), by: null, created_at: null, legacy: true });
  return out;
}
export function gpInvalid(p) {
  const g1g = p.godparent1_gender, g2g = p.godparent2_gender;
  const sameGender = g1g && g2g && p.godparent2_name && g1g === g2g;
  const bothNonCath = p.godparent1_name && p.godparent2_name && p.godparent1_catholic === false && p.godparent2_catholic === false;
  return sameGender || bothNonCath;
}
export function delegationFlag(p) { return !!p.officiant_override && !p.delegation_given; }
export function ageFlag(p) { const a = ageOf(dobOf(p)); return a !== null && a > 7; }

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadTemplate() {
  const { data } = await sb.from('baptism_templates').select('*').limit(1);
  _tplRow = (data && data[0]) || { documents: [], steps: [{ step: 'Parent Preparation Complete', deletable: true }] };
}
// Fetch-only (no render) — used by the shell's config.fetchRecords.
export async function loadBaptismData() {
  await Promise.all([loadTemplate(), loadBapCoordinator()]);
  // Parish-scope: fetch the UNION of parishes this user can access (the in-panel
  // switcher then filters per-tab client-side). Single-parish → [home], identical to
  // the old strict .eq. Fallback to the home parish when the group list is empty
  // (no-group / unresolved), preserving legacy single-parish behavior.
  const ids = accessibleParishesForSacrament(['baptism']).map(p => p.id);
  let _q = sb.from('sacramental_baptism').select('*').order('created_at', { ascending: false });
  if (ids.length) _q = _q.in('parish_id', ids);
  else if (store.parishSettings?.id) _q = _q.eq('parish_id', store.parishSettings.id);
  const { data, error } = await _q;
  if (error) { console.error('[baptism]', error); return; }
  allBap = data || [];
  store.allBaptism = allBap;
  updateStats();
  return allBap;
}
export function getBapRecords() { return allBap; }
export function getBapRecord(id) { return allBap.find(x => x.id === id) || null; }
export { fullAccess as bapCanManage };
export function bapTemplate() { return _tplRow; }

// Nav loader — fetch then mount the master-detail shell into #baptism-root.
export async function loadBaptism() {
  await loadBaptismData();
  const root = document.getElementById('baptism-root');
  if (!root) return;
  const { baptismConfig } = await import('../sacramental/baptismConfig.js');
  renderSacramentalPanel(root, baptismConfig);
}
function updateStats() {
  const active = allBap.filter(p => !p.archived && statusOf(p) !== 'inactive');
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('stat-bap-total', active.length);
  set('stat-bap-upcoming', active.filter(p => bapDate(p) && bapDate(p) >= todayCST() && statusOf(p) === 'scheduled').length);
  set('stat-bap-docs', active.filter(p => !p.preparation_complete).length);
}

// ── Read-detail helpers (consumed by baptismConfig detail sections) ──────────
export function churchName(p) { if (p.baptism_institution_id) { const i = (store.institutions || []).find(x => x.id === p.baptism_institution_id); if (i) return i.name; } return p.baptism_church_override || ''; }
export function officiantName(p) { return p.officiant_id ? ((store.personnel || []).find(x => x.id === p.officiant_id)?.name || '') : (p.officiant_override || ''); }

// Cross-link entry — open a specific baptism file in the shell (deep-link).
export async function expandBaptism(id) {
  openSacramentalRecord('baptism', id);   // set hash first so the shell opens it on mount
  window.switchPanel('baptism');
}

// ── Autosave (used by the read-detail prep checkbox + add-note) ──────────────
async function _patch(id, patch) { const p = allBap.find(x => x.id === id); if (!p) return null; const { error } = await serializeWrite(`baptism:${id}`, () => withWriteRetry(() => sb.from('sacramental_baptism').update({ ...patch, updated_at: nowIso() }).eq('id', id), { kind: 'update' })); if (error) { alert('Save failed: ' + error.message); return null; } Object.assign(p, patch); return p; }
async function toggleBapPrep(id) {
  const p = allBap.find(x => x.id === id); if (!p) return;
  const done = !p.preparation_complete;
  const patch = { preparation_complete: done, preparation_complete_date: done ? todayCST() : null, preparation_complete_by: done ? _curUserId() : null };
  if (await _patch(id, patch)) { updateStats(); refreshActivePanel(); }
}
async function addBapNote(id) {
  const inp = document.getElementById('bn-' + id); const note = (inp?.value || '').trim(); if (!note) return;
  const p = allBap.find(x => x.id === id); if (!p) return;
  const log = Array.isArray(p.notes_log) ? JSON.parse(JSON.stringify(p.notes_log)) : [];
  log.push({ note, by: _curUserName(), created_at: nowIso() });
  if (await _patch(id, { notes_log: log })) window.flashSavedThen(() => refreshActivePanel());
}
// Edit a notes_log note in place (shared shape): overwrite text + stamp edited_at.
async function bapEditNote(id, idx) {
  const p = allBap.find(x => x.id === id); if (!p) return;
  const log = editNoteLog(p.notes_log, idx, nowIso);
  if (!log) return;
  if (await _patch(id, { notes_log: log })) window.flashSavedThen(() => refreshActivePanel());
}

// ── Big modal ────────────────────────────────────────────────────────────────
function _bapOverlay() { let ov = document.getElementById('bap-overlay'); if (!ov) { ov = document.createElement('div'); ov.id = 'bap-overlay'; ov.className = 'modal-overlay'; ov.innerHTML = `<div class="modal anl-modal"><button class="modal-close" onclick="bapCloseModal()">×</button><div id="bap-modal-content"></div></div>`; document.body.appendChild(ov); ov.addEventListener('click', e => { if (e.target === ov) bapCloseModal(); }); } return ov; }
function _bapOpen(html) { _bapOverlay(); document.getElementById('bap-modal-content').innerHTML = html; document.getElementById('bap-overlay').classList.add('open'); }
function bapCloseModal() { document.getElementById('bap-overlay')?.classList.remove('open'); _M = null; }

function _row(...cells) { return `<div style="display:flex;gap:8px;flex-wrap:wrap;">${cells.map(c => `<div style="flex:1;min-width:120px;">${c}</div>`).join('')}</div>`; }
function _input(id, label, val = '', type = 'text', extra = '') { return `<label>${label}</label><input type="${type}" id="${id}" value="${_esc(val)}" ${extra} />`; }
function _stateSelect(id, val) { return `<label>State</label><select id="${id}"><option value="">—</option>${US_STATES.map(s => `<option${s === val ? ' selected' : ''}>${s}</option>`).join('')}</select>`; }
function _toggle(id, label, on, onchange = '') { return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:.75rem;"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${onchange ? `onchange="${onchange}"` : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" />${label}</label>`; }
function _sectionHead(t) { return `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--cardinal);margin:1.4rem 0 .5rem;border-bottom:.5px solid var(--stone);padding-bottom:4px;">${t}</div>`; }

async function openBapCreate() {
  _M = newModalState(null);
  _bapOpen(buildModalHtml(null)); bapValidate();
}
function openBapEdit(id) { const p = allBap.find(x => x.id === id); if (!p) return; _M = newModalState(p); _bapOpen(buildModalHtml(p)); bapValidate(); }
function newModalState(p) {
  return {
    id: p?.id || null, isEdit: !!p,
    showParent2: !!(p?.parent2_first || p?.parent2_last),
    isAdopted: !!p?.is_adopted,
    gp1: { name: p?.godparent1_name || p?.godfather || '', gender: p?.godparent1_gender || '', catholic: p?.godparent1_catholic !== false },
    gp2: { name: p?.godparent2_name || p?.godmother || '', gender: p?.godparent2_gender || '', catholic: p?.godparent2_catholic !== false, shown: !!(p?.godparent2_name || p?.godmother) },
    officiantOther: !p?.officiant_id && !!p?.officiant_override,
    instMode: p?.baptism_institution_id ? 'inst' : (p?.baptism_church_override ? 'other' : ''),
  };
}

// Inline edit form for the shell detail pane: reuse the exact form markup, but
// skip the modal-title + modal-actions (the shell renders Save/Cancel/Delete).
export function buildBapEditForm(p) {
  _M = newModalState(p);
  const html = buildModalHtml(p, { inline: true });
  setTimeout(() => bapValidate(), 0);   // run age-gate/godparent validation on mount
  return html;
}

function buildModalHtml(p, opts = {}) {
  const inline = !!opts.inline;
  const isEdit = _M.isEdit;
  const offOpts = clergyPersonnel().map(c => `<option value="${c.id}"${p?.officiant_id === c.id ? ' selected' : ''}>${_esc(c.name)}</option>`).join('');
  const instOpts = (store.institutions || []).map(i => `<option value="${i.id}"${p?.baptism_institution_id === i.id ? ' selected' : ''}>${_esc(i.name)}</option>`).join('');
  const np = { first: p?.first_name || (p?.name || '').split(/\s+/)[0] || '', middle: p?.middle_name || '', last: p?.last_name || (p?.name || '').split(/\s+/).slice(1).join(' ') || '' };

  let h = inline ? '' : `<div class="modal-title">${isEdit ? 'Edit Baptism File' : 'New Baptism'}</div>`;

  // 0 — Parish picker. CREATE (All tab, >1 parish): placeholder + Save-lockout. EDIT
  // (>1 parish): the record's parish preselected, reassignable, NO lockout. Distinct ids.
  if ((!isEdit && !inline) && shouldShowParishField(['baptism'], 'baptism')) {
    h += parishCreateFieldHtml(['baptism'], { selectId: 'bf-parish-select', onChange: "bapValidate();window._preparerRepopulateCoords('bf-preparer','baptism',this.value)" });
  } else if (isEdit && shouldShowParishFieldEdit(['baptism'])) {
    h += parishEditFieldHtml(['baptism'], { selectId: 'bf-parish-edit', currentParishId: p?.parish_id || null, onChange: "window._preparerRepopulateCoords('bf-preparer','baptism',this.value)" });
  }

  // 1 — Person responsible for formation (clergy + Baptism coordinator + Other)
  h += _sectionHead('Person Responsible for Formation');
  h += buildPreparerField('bf-preparer', p?.preparer || '', { coordinatorNames: _bapCoordinatorNames, label: 'Person Responsible for Formation', prog: 'baptism', initialParishId: isEdit ? (p?.parish_id || null) : initialCreateParish(['baptism'], 'baptism') });

  // 2 — Child information
  h += _sectionHead('Child Information');
  h += _row(_input('bf-first', 'First Name', np.first), _input('bf-middle', 'Middle', np.middle), _input('bf-last', 'Last Name', np.last));
  h += `<label>Date of Birth <span style="color:var(--cardinal);">*</span></label><input type="date" id="bf-dob" value="${(p?.dob && /^\d{4}-\d{2}-\d{2}/.test(p.dob)) ? p.dob.slice(0, 10) : ''}" oninput="bapValidate()" />`;
  h += `<div id="bf-agegate" class="anl-info-box" style="display:none;background:#FDEDEC;border-left-color:#E74C3C;color:#922B21;">This child is above the age of reason. Please use the OCIA panel for candidates over age 7.</div>`;
  // age-gated body
  h += `<div id="bf-body">`;
  h += _input('bf-street', 'Mailing Street Address', p?.child_street || '');
  h += _row(_input('bf-city', 'City', p?.child_city || ''), _stateSelect('bf-state', p?.child_state || ''), _input('bf-zip', 'ZIP', p?.child_zip || ''));

  // 3 — Parents (moved ABOVE Baptism Details)
  h += _sectionHead('Parent / Guardian 1');
  h += _row(_input('bf-p1first', 'First Name', p?.parent1_first || ''), _input('bf-p1last', 'Last Name', p?.parent1_last || ''));
  h += _row(_input('bf-p1phone', 'Cell Phone', p?.parent1_phone || '', 'tel'), _input('bf-p1email', 'Email', p?.parent1_email || ''));
  h += _toggle('bf-p1cath', 'Catholic?', p?.parent1_catholic !== false, 'bapParentCathChange(1)');
  h += `<div id="bf-p1note" class="anl-info-box" style="display:${p?.parent1_catholic === false ? 'block' : 'none'};">Non-Catholic parent — see godparent requirements.</div>`;
  // parent 2 optional
  h += `<div id="bf-p2-wrap" style="display:${_M.showParent2 ? 'block' : 'none'};">
    ${_sectionHead('Parent / Guardian 2')}
    ${_row(_input('bf-p2first', 'First Name', p?.parent2_first || ''), _input('bf-p2last', 'Last Name', p?.parent2_last || ''))}
    ${_row(_input('bf-p2phone', 'Cell Phone', p?.parent2_phone || '', 'tel'), _input('bf-p2email', 'Email', p?.parent2_email || ''))}
    ${_toggle('bf-p2cath', 'Catholic?', p?.parent2_catholic !== false, 'bapParentCathChange(2)')}
    <div id="bf-p2note" class="anl-info-box" style="display:${p?.parent2_catholic === false ? 'block' : 'none'};">Non-Catholic parent — see godparent requirements.</div>
    <button class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;margin-top:8px;" onclick="bapToggleParent2(false)">× Remove second parent</button>
  </div>
  <button id="bf-add-p2" class="btn-secondary" style="display:${_M.showParent2 ? 'none' : 'inline-block'};padding:.3rem .8rem;font-size:12px;margin-top:8px;" onclick="bapToggleParent2(true)">+ Add second parent/guardian</button>`;

  // 4 — Baptism details
  h += _sectionHead('Baptism Details');
  h += _input('bf-bdate', 'Baptism Date', bapDate(p) || '', 'date');
  h += `<label>Church of Baptism</label><select id="bf-inst" onchange="bapInstChange(this.value)"><option value="">— Select —</option>${instOpts}<option value="__other"${_M.instMode === 'other' ? ' selected' : ''}>Other…</option></select>
    <div id="bf-inst-other-wrap" style="display:${_M.instMode === 'other' ? 'block' : 'none'};">${_input('bf-church-override', 'Church name', p?.baptism_church_override || '')}</div>
    ${_row(_input('bf-bcity', 'City', p?.baptism_city || ''), _stateSelect('bf-bstate', p?.baptism_state || ''))}`;

  // adoption
  h += _sectionHead('Adoption');
  h += _toggle('bf-adopted', 'Child is adopted?', _M.isAdopted, 'bapAdoptChange()');
  h += `<div id="bf-adopt-wrap" style="display:${_M.isAdopted ? 'block' : 'none'};">
    ${_row(_input('bf-birthfather', 'Birth Father Name (optional)', p?.birth_father_name || ''), _input('bf-birthmother', 'Birth Mother Name (optional)', p?.birth_mother_name || ''))}
    <div class="anl-info-box">Birth parent information is confidential and will not appear on the baptismal certificate.</div>
  </div>`;

  // 5 — Godparents
  h += _sectionHead('Godparents');
  h += `<div id="bf-gp1">${godparentRow(1)}</div>`;
  h += `<div id="bf-gp2-wrap" style="display:${_M.gp2.shown ? 'block' : 'none'};">${godparentRow(2)}</div>`;
  h += `<button id="bf-add-gp2" class="btn-secondary" style="display:${_M.gp2.shown ? 'none' : 'inline-block'};padding:.3rem .8rem;font-size:12px;margin-top:8px;" onclick="bapToggleGp2(true)">+ Add second godparent</button>`;
  h += `<div id="bf-gp-error" class="anl-info-box" style="display:none;background:#FDEDEC;border-left-color:#E74C3C;color:#922B21;"></div>`;

  // 6 — Officiant
  h += _sectionHead('Officiant');
  h += `<label>Officiant</label><select id="bf-officiant" onchange="bapOfficiantChange(this.value)"><option value="">— Select —</option>${offOpts}<option value="__other"${_M.officiantOther ? ' selected' : ''}>Other…</option></select>
    <div id="bf-officiant-other-wrap" style="display:${_M.officiantOther ? 'block' : 'none'};">${_input('bf-officiant-override', 'Officiant name', p?.officiant_override || '')}${_toggle('bf-delegation', 'Delegation Given?', !!p?.delegation_given)}</div>`;

  h += `</div>`; // end bf-body

  if (isEdit) {
    h += _sectionHead('Status');
    h += `<label>Status</label><select id="bf-status">${Object.entries(BAP_STATUS).map(([k, v]) => `<option value="${k}"${statusOf(p) === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`;
    h += _toggle('bf-archive', 'Archive this file', !!p?.archived);
  }

  if (!inline) {
    h += `<div class="modal-actions" style="justify-content:space-between;">
      ${isEdit ? `<button class="btn-delete" onclick="bapDeletePerson('${_M.id}')">Delete</button>` : '<span></span>'}
      <div style="display:flex;gap:8px;"><button class="btn-secondary" onclick="bapCloseModal()">Cancel</button><button class="btn-primary" id="bf-save" onclick="bapSave()">${isEdit ? 'Save' : 'Create File'}</button></div>
    </div>`;
  }
  return h;
}

function godparentRow(n) {
  const gp = _M['gp' + n];
  const idp = 'bf-gp' + n;
  return `<div class="bf-gp-block" data-gp="${n}">
    <div style="font-size:12px;font-weight:600;color:#555;margin-top:.5rem;">Godparent ${n}${n === 1 ? ' (required)' : ''}</div>
    ${_input(idp + '-name', 'Name', gp.name, 'text', `oninput="bapGpChange(${n})"`)}
    <label>Gender ${n === 1 ? '<span style="color:var(--cardinal);">*</span>' : ''}</label>
    <div style="display:flex;gap:16px;margin-top:2px;">
      <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;margin:0;"><input type="radio" name="${idp}-gender" value="male" ${gp.gender === 'male' ? 'checked' : ''} onchange="bapGpChange(${n})" /> Male</label>
      <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;margin:0;"><input type="radio" name="${idp}-gender" value="female" ${gp.gender === 'female' ? 'checked' : ''} onchange="bapGpChange(${n})" /> Female</label>
    </div>
    ${_toggle(idp + '-cath', 'Catholic?', gp.catholic, `bapGpChange(${n})`)}
    <div id="${idp}-warn" class="anl-info-box" style="display:${gp.name && !gp.catholic ? 'block' : 'none'};">A non-Catholic Christian may serve as a Christian witness only, not as a godparent.</div>
    ${n === 2 ? `<button class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;margin-top:8px;" onclick="bapToggleGp2(false)">× Remove second godparent</button>` : ''}
  </div>`;
}

// ── Modal handlers ───────────────────────────────────────────────────────────
function bapInstChange(v) {
  _M.instMode = v === '__other' ? 'other' : (v ? 'inst' : '');
  document.getElementById('bf-inst-other-wrap').style.display = _M.instMode === 'other' ? 'block' : 'none';
  const ce = document.getElementById('bf-bcity'), se = document.getElementById('bf-bstate');
  if (_M.instMode === 'inst') { const inst = (store.institutions || []).find(x => x.id === v); const cs = parseCityState(inst?.address || ''); if (ce) { if (cs.city) ce.value = cs.city; ce.readOnly = true; ce.style.background = '#F0EDE8'; } if (se) { if (cs.state) se.value = cs.state; se.disabled = true; se.style.background = '#F0EDE8'; } }
  else { if (ce) { ce.readOnly = false; ce.style.background = '#fff'; } if (se) { se.disabled = false; se.style.background = '#fff'; } }
}
function parseCityState(addr) { if (!addr) return {}; const parts = addr.split(',').map(s => s.trim()).filter(Boolean); if (parts.length < 2) return {}; const city = parts[parts.length - 2]; const sz = parts[parts.length - 1].split(/\s+/); return { city, state: US_STATES.includes(sz[0]) ? sz[0] : '' }; }
function bapParentCathChange(n) { const on = document.getElementById('bf-p' + n + 'cath').checked; const note = document.getElementById('bf-p' + n + 'note'); if (note) note.style.display = on ? 'none' : 'block'; }
function bapToggleParent2(show) { _M.showParent2 = show; document.getElementById('bf-p2-wrap').style.display = show ? 'block' : 'none'; document.getElementById('bf-add-p2').style.display = show ? 'none' : 'inline-block'; }
function bapAdoptChange() { _M.isAdopted = document.getElementById('bf-adopted').checked; document.getElementById('bf-adopt-wrap').style.display = _M.isAdopted ? 'block' : 'none'; }
function bapOfficiantChange(v) { _M.officiantOther = v === '__other'; document.getElementById('bf-officiant-other-wrap').style.display = _M.officiantOther ? 'block' : 'none'; }
function bapToggleGp2(show) { _M.gp2.shown = show; document.getElementById('bf-gp2-wrap').style.display = show ? 'block' : 'none'; document.getElementById('bf-gp2-wrap').innerHTML = show ? godparentRow(2) : ''; document.getElementById('bf-add-gp2').style.display = show ? 'none' : 'inline-block'; if (!show) _M.gp2 = { name: '', gender: '', catholic: true, shown: false }; bapValidate(); }
function bapGpChange(n) {
  const idp = 'bf-gp' + n;
  _M['gp' + n].name = document.getElementById(idp + '-name')?.value.trim() || '';
  _M['gp' + n].gender = document.querySelector(`input[name="${idp}-gender"]:checked`)?.value || '';
  _M['gp' + n].catholic = document.getElementById(idp + '-cath')?.checked ?? true;
  const warn = document.getElementById(idp + '-warn'); if (warn) warn.style.display = (_M['gp' + n].name && !_M['gp' + n].catholic) ? 'block' : 'none';
  bapValidate();
}

function bapValidate() {
  // age gate
  const age = ageOf(document.getElementById('bf-dob')?.value);
  const overAge = age !== null && age > 7;
  const gate = document.getElementById('bf-agegate'); if (gate) gate.style.display = overAge ? 'block' : 'none';
  const body = document.getElementById('bf-body'); if (body) { body.style.opacity = overAge ? '.4' : '1'; body.style.pointerEvents = overAge ? 'none' : 'auto'; }
  // godparent validation
  const g1 = _M.gp1, g2 = _M.gp2;
  const both = g1.name && g2.shown && g2.name;
  const sameGender = both && g1.gender && g2.gender && g1.gender === g2.gender;
  const bothNonCath = both && !g1.catholic && !g2.catholic;
  const gpErr = document.getElementById('bf-gp-error');
  let msg = '';
  if (sameGender) msg = 'Canon Law permits only one male and one female godparent. Please correct before saving.';
  else if (bothNonCath) msg = 'At least one godparent must be Catholic.';
  if (gpErr) { gpErr.style.display = msg ? 'block' : 'none'; gpErr.textContent = msg; }
  [document.getElementById('bf-gp1'), document.getElementById('bf-gp2-wrap')].forEach(el => { if (el) { el.style.opacity = msg ? '.5' : '1'; } });
  // save button — also locked until a parish is chosen when the create parish field shows
  const invalid = overAge || !!msg || !parishFieldValid(['baptism'], 'baptism', 'bf-parish-select');
  const btn = document.getElementById('bf-save'); if (btn) { btn.disabled = invalid; btn.style.opacity = invalid ? '.5' : '1'; btn.style.cursor = invalid ? 'not-allowed' : 'pointer'; }
  return !invalid;
}

// ── Save ─────────────────────────────────────────────────────────────────────
function _v(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function _chk(id) { return !!document.getElementById(id)?.checked; }
// Build the DB payload from the (modal OR inline) form — shared by all save paths.
function _bapPayloadFromDom() {
  const first = _v('bf-first'), last = _v('bf-last');
  const name = [first, _v('bf-middle'), last].filter(Boolean).join(' ');
  const instSel = document.getElementById('bf-inst')?.value || '';
  const offSel = document.getElementById('bf-officiant')?.value || '';
  const p2 = _M.showParent2;
  const payload = {
    name, first_name: first || null, middle_name: _v('bf-middle') || null, last_name: last || null,
    dob: _v('bf-dob') || null,
    preparer: readPreparerValue('bf-preparer'),
    child_street: _v('bf-street') || null, child_city: _v('bf-city') || null, child_state: _v('bf-state') || null, child_zip: _v('bf-zip') || null,
    baptism_date: _v('bf-bdate') || null,
    baptism_institution_id: instSel && instSel !== '__other' ? instSel : null,
    baptism_church_override: instSel === '__other' ? (_v('bf-church-override') || null) : null,
    baptism_city: _v('bf-bcity') || null, baptism_state: _v('bf-bstate') || null,
    parent1_first: _v('bf-p1first') || null, parent1_last: _v('bf-p1last') || null, parent1_phone: normalizePhone(_v('bf-p1phone')) || null, parent1_email: _v('bf-p1email') || null, parent1_catholic: _chk('bf-p1cath'),
    parent2_first: p2 ? (_v('bf-p2first') || null) : null, parent2_last: p2 ? (_v('bf-p2last') || null) : null, parent2_phone: p2 ? (normalizePhone(_v('bf-p2phone')) || null) : null, parent2_email: p2 ? (_v('bf-p2email') || null) : null, parent2_catholic: p2 ? _chk('bf-p2cath') : true,
    is_adopted: _M.isAdopted,
    birth_father_name: _M.isAdopted ? (_v('bf-birthfather') || null) : null,
    birth_mother_name: _M.isAdopted ? (_v('bf-birthmother') || null) : null,
    godparent1_name: _M.gp1.name || null, godparent1_gender: _M.gp1.gender || null, godparent1_catholic: _M.gp1.catholic,
    godparent2_name: _M.gp2.shown ? (_M.gp2.name || null) : null, godparent2_gender: _M.gp2.shown ? (_M.gp2.gender || null) : null, godparent2_catholic: _M.gp2.shown ? _M.gp2.catholic : true,
    officiant_id: offSel && offSel !== '__other' ? offSel : null,
    officiant_override: offSel === '__other' ? (_v('bf-officiant-override') || null) : null,
    delegation_given: offSel === '__other' ? _chk('bf-delegation') : false,
    updated_at: nowIso(),
  };
  return { payload, name };
}

// Modal create path (the list "New" button still uses the existing modal).
async function bapSave() {
  if (!bapValidate()) { alert('Please resolve the highlighted issues before saving.'); return; }
  const { payload, name } = _bapPayloadFromDom();
  if (!name) { alert('Child name is required.'); return; }
  if (!_v('bf-dob')) { alert('Date of birth is required.'); return; }
  if (_M.isEdit) {
    const r = await _bapWriteEdit(_M.id, payload, name);
    if (!r.ok) return;
    window.flashSavedThen(async () => { bapCloseModal(); await loadBaptism(); });
  } else {
    payload.status_code = 'scheduled';
    payload.archived = false;
    payload.timeline = [{ type: 'auto', text: 'File opened', created_at: nowIso() }];
    payload.parish_id = resolveCreateParish(['baptism'], 'baptism', 'bf-parish-select');   // field value / active tab / single parish
    if (!payload.parish_id) { alert('Please select a parish for this record.'); return; }   // safety floor (lockout already prevents this)
    const { error } = await insertWithRetry('sacramental_baptism', payload);
    if (error) { reportWriteError('baptism insert', error); return; }
    logActivity({ action: 'added Baptism child', entityType: 'baptism', entityName: name, contextType: 'baptism' });
    const { data: { user } } = await sb.auth.getUser();
    const uids = await getUserIdsForSacrament('baptism', payload.parish_id ?? null);   // route to the NEW record's parish, not the admin's home
    notifyUsers(uids, user?.id, `New baptism file added: ${name}`, 'info', 'baptism');
    window.flashSavedThen(async () => { bapCloseModal(); await loadBaptism(); });
  }
}

// Shared edit-write: applies status/archive/timeline, writes, updates cache.
async function _bapWriteEdit(id, payload, name) {
  const prior = allBap.find(x => x.id === id);
  const newStatus = document.getElementById('bf-status')?.value || statusOf(prior);
  payload.status_code = newStatus;
  payload.archived = _chk('bf-archive');
  const tl = JSON.parse(JSON.stringify(prior?.timeline || []));
  if (prior && statusOf(prior) !== 'complete' && newStatus === 'complete') tl.push({ type: 'auto', text: 'Baptism Complete', created_at: nowIso() });
  payload.timeline = tl;
  const _ep = readEditParish('bf-parish-edit'); if (_ep) payload.parish_id = _ep;   // parish reassignment (edit field shown)
  const priorStatus = prior ? statusOf(prior) : null;
  const { error } = await withWriteRetry(() => sb.from('sacramental_baptism').update(payload).eq('id', id), { kind: 'update' });
  if (error) { reportWriteError('baptism update', error); return { ok: false }; }
  logActivity({ action: 'updated Baptism record', entityType: 'baptism', entityName: name, contextType: 'baptism', contextId: id });
  // Notify on TRANSITION into a fire-state (Scheduled / Complete) — two distinct
  // lifecycle events, not re-fired on resaves while already in the state. Baptism is
  // not cross-linkable (originType null) → origin-panel recipients only.
  if (priorStatus !== newStatus && (newStatus === 'scheduled' || newStatus === 'complete')) {
    const { data: { user } } = await sb.auth.getUser();
    notifySacramentEvent({
      keys: ['baptism'], parishId: payload.parish_id ?? prior?.parish_id ?? null, actorUserId: user?.id,   // route to the record's CURRENT parish (handles reassignment)
      message: newStatus === 'complete' ? `${name} Baptism — marked complete` : `${name} Baptism — scheduled`,
      type: newStatus === 'complete' ? 'success' : 'info', module: 'baptism', record_id: id,
    });
  }
  if (prior) Object.assign(prior, payload);
  return { ok: true, record: prior };
}

// Shell config.saveRecord — inline-edit save: write + update cache, no remount.
export async function bapSaveEdit(id) {
  if (!bapValidate()) { alert('Please resolve the highlighted issues before saving.'); return { ok: false }; }
  const { payload, name } = _bapPayloadFromDom();
  if (!name) { alert('Child name is required.'); return { ok: false }; }
  if (!_v('bf-dob')) { alert('Date of birth is required.'); return { ok: false }; }
  updateStats();
  return _bapWriteEdit(id, payload, name);
}

// Shell config.deleteRecord
export async function bapDeleteRec(id) {
  if (!confirm('Permanently delete this record? This cannot be undone.')) return { ok: false };
  // Capture the display name BEFORE deletion — the record is gone afterward.
  const _name = allBap.find(x => x.id === id)?.name || 'Baptism record';
  const { error } = await deleteWithRetry(() => sb.from('sacramental_baptism').delete().eq('id', id));
  if (error) { alert('Delete failed: ' + error.message); return { ok: false }; }
  allBap = allBap.filter(x => x.id !== id);
  logActivity({ action: 'deleted Baptism record', entityType: 'baptism', entityName: _name, contextType: 'baptism' });
  updateStats();
  return { ok: true };
}

// Shell config.bulkUpdateStatus
export async function bapBulkStatus(ids, status) {
  for (const id of ids) {
    const { error } = await sb.from('sacramental_baptism').update({ status_code: status, updated_at: nowIso() }).eq('id', id);
    if (error) { alert('Bulk update failed: ' + error.message); return { ok: false }; }
    const p = allBap.find(x => x.id === id); if (p) p.status_code = status;
  }
  logActivity({ action: 'bulk-updated Baptism status', entityType: 'baptism', entityName: `${ids.length} files`, contextType: 'baptism' });
  updateStats();
  return { ok: true };
}
async function bapDeletePerson(id) {
  if (!confirm('Permanently delete this record? This cannot be undone.')) return;
  const { error } = await deleteWithRetry(() => sb.from('sacramental_baptism').delete().eq('id', id));
  if (error) { alert('Delete failed: ' + error.message); return; }
  bapCloseModal(); await loadBaptism();
}

// ── Template (documents + steps) ─────────────────────────────────────────────
let _tplState = null, _bapStepDrag = null;
const DEFAULT_BAP_STEPS = [{ step: 'Parent Preparation Complete', deletable: true }];
function openBapTemplate() {
  const base = _tplRow ? JSON.parse(JSON.stringify(_tplRow)) : {};
  _tplState = { documents: base.documents || [], steps: base.steps || JSON.parse(JSON.stringify(DEFAULT_BAP_STEPS)) };
  _bapOpen(buildTplHtml());
}
function buildTplHtml() {
  return `<div class="modal-title">Baptism Template</div>
    ${_sectionHead('Documents')}
    <div style="font-size:12px;color:#6B7280;margin-bottom:8px;">Baptismal Certificate is automatically added for all records and cannot be removed.</div>
    <div id="bt-docs-list">${renderTplDocs()}</div>
    <div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="bt-doc-new" placeholder="Add document…" style="flex:1;border-radius:6px;border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();bapTplAddDoc();}" /><button class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;" onclick="bapTplAddDoc()">+ Add</button></div>
    ${_sectionHead('Steps')}
    <div style="font-size:12px;color:#6B7280;margin-bottom:8px;">Parent Preparation Complete is the standard step.</div>
    <div id="bt-steps-list">${renderTplSteps()}</div>
    <div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="bt-step-new" placeholder="Add step…" style="flex:1;border-radius:6px;border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();bapTplAddStep();}" /><button class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;" onclick="bapTplAddStep()">+ Add</button></div>
    <div style="font-size:12px;color:#6B7280;font-style:italic;margin-top:1rem;">Changes apply to new files only.</div>
    <div class="modal-actions"><button class="btn-secondary" onclick="bapCloseModal()">Cancel</button><button class="btn-primary" onclick="bapTplSave()">Save</button></div>`;
}
function renderTplDocs() {
  return (_tplState.documents || []).map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;"><span style="flex:1;font-size:13px;">${_esc(d.name)}</span>${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;"></i>` : `<button onclick="bapTplRemoveDoc(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;">×</button>`}</div>`).join('') || `<div style="font-size:12px;color:#9CA3AF;font-style:italic;">No documents.</div>`;
}
function renderTplSteps() {
  return (_tplState.steps || []).map((s, i) => `<div draggable="true" ondragstart="bapTplStepDragStart(event,${i})" ondragover="event.preventDefault()" ondrop="bapTplStepDrop(event,${i})" style="display:flex;align-items:center;gap:8px;padding:3px 0;"><i class="fa-solid fa-grip-vertical" style="color:#CBD5E1;font-size:12px;cursor:grab;" title="Drag to reorder"></i><span style="flex:1;font-size:13px;">${_esc(s.step)}</span><button onclick="bapTplRemoveStep(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;">×</button></div>`).join('') || `<div style="font-size:12px;color:#9CA3AF;font-style:italic;">No steps.</div>`;
}
function bapTplAddDoc() { const inp = document.getElementById('bt-doc-new'); const n = (inp?.value || '').trim(); if (!n) return; (_tplState.documents = _tplState.documents || []).push({ name: n, deletable: true }); inp.value = ''; document.getElementById('bt-docs-list').innerHTML = renderTplDocs(); }
function bapTplRemoveDoc(i) { _tplState.documents.splice(i, 1); document.getElementById('bt-docs-list').innerHTML = renderTplDocs(); }
function bapTplAddStep() { const inp = document.getElementById('bt-step-new'); const n = (inp?.value || '').trim(); if (!n) return; (_tplState.steps = _tplState.steps || []).push({ step: n, deletable: true }); inp.value = ''; document.getElementById('bt-steps-list').innerHTML = renderTplSteps(); }
function bapTplRemoveStep(i) { _tplState.steps.splice(i, 1); document.getElementById('bt-steps-list').innerHTML = renderTplSteps(); }
function bapTplStepDragStart(e, i) { _bapStepDrag = i; }
function bapTplStepDrop(e, i) { e.preventDefault(); if (_bapStepDrag === null || _bapStepDrag === i) return; const arr = _tplState.steps || []; const [moved] = arr.splice(_bapStepDrag, 1); arr.splice(i, 0, moved); _bapStepDrag = null; document.getElementById('bt-steps-list').innerHTML = renderTplSteps(); }
async function bapTplSave() {
  const payload = { documents: _tplState.documents || [], steps: _tplState.steps || [], updated_at: nowIso() };
  let error;
  if (_tplRow?.id) { ({ error } = await sb.from('baptism_templates').update(payload).eq('id', _tplRow.id)); }
  else { ({ error } = await sb.from('baptism_templates').insert(payload)); }
  if (error) { alert('Save failed: ' + error.message); return; }
  _tplRow = { ..._tplRow, ...payload };
  window.flashSaved();   // shared green "Saved ✓" confirmation
}

Object.assign(window, {
  loadBaptism, expandBaptism,
  openBapCreate, openBapEdit, openBapTemplate, bapCloseModal,
  toggleBapPrep, addBapNote, bapEditNote,
  bapInstChange, bapParentCathChange, bapToggleParent2, bapAdoptChange, bapOfficiantChange,
  bapToggleGp2, bapGpChange, bapValidate,
  bapSave, bapDeletePerson,
  bapTplAddDoc, bapTplRemoveDoc, bapTplAddStep, bapTplRemoveStep, bapTplStepDragStart, bapTplStepDrop, bapTplSave,
});
