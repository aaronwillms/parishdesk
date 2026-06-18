import { sb } from '../supabase.js';
import { fmtDate, formatDateDisplay, daysUntil, todayCST, logActivity, reportWriteError } from '../utils.js';
import { store } from '../store.js';
import { expandCase } from './annulments.js';
import { isAdmin, canAccessSacrament, isSacramentCoordinator } from '../roles.js';
import { notifyUsers, getUserIdsForSacrament } from '../notifications.js';
import { formatPhone, normalizePhone } from '../utils/phone.js';
import { renderSacramentalPanel, refreshActivePanel, openSacramentalRecord } from '../sacramental/panelShell.js';
import { buildPreparerField, readPreparerValue, clergyNames } from '../sacramental/preparerField.js';
import { buildOfficiantField, readOfficiantValue, officiantIsOther } from '../sacramental/officiantField.js';

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
const MTYPE_BADGE = { nuptial_mass:'Nuptial Mass', outside_mass:'Outside Mass', convalidation:'Convalidation', sanatio:'Sanatio', external:'External' };
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
const CLERGY_TYPES = ['pastor', 'parochial-vicar', 'priest-in-residence', 'deacon', 'religious'];

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
function clergyPersonnel() {
  // Clergy are identified by personnel.type. (The legacy title-regex match was
  // retired with personnel.title in the HR collapse.)
  return (store.personnel || []).filter(p => CLERGY_TYPES.includes(p.type))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

// ── Field accessors (backward-compatible) ────────────────────────────────────
function marType(c) {
  const t = c.marriage_type;
  if (c.is_external) return 'external';
  if (!t) return 'nuptial_mass';
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
  return (c.documents || []).map(d => ({ name: d.name, received: d.received ?? d.done ?? false, deletable: d.deletable ?? !d.auto, auto: !!d.auto }));
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
function notesOf(c) {
  const out = (Array.isArray(c.notes_log) ? c.notes_log : []).map(n => ({ note: n.note || '', by: n.by || null, created_at: n.created_at || null }));
  if (c.notes && String(c.notes).trim()) out.push({ note: String(c.notes).trim(), by: null, created_at: null, legacy: true });
  return out;
}
function hasDelegationFlag(c) { return !!c.officiant_override && !c.delegation_given; }

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadTemplates() {
  const { data, error } = await sb.from('marriage_templates').select('marriage_type, documents, steps, fees_enabled, fees');
  _templates = {};
  if (!error && data) data.forEach(r => { _templates[r.marriage_type] = { documents: r.documents || [], steps: r.steps || [], fees_enabled: r.fees_enabled !== false, fees: r.fees || [] }; });
  Object.keys(FALLBACK_TEMPLATES).forEach(k => { if (!_templates[k]) _templates[k] = JSON.parse(JSON.stringify(FALLBACK_TEMPLATES[k])); });
}

async function loadMarriageCoordinator() {
  try {
    const { data } = await sb.from('program_coordinators').select('coordinator_ids').eq('program', 'marriage').maybeSingle();
    _marCoordinatorNames = (data?.coordinator_ids || []).map(pid => (store.personnel || []).find(p => p.id === pid)?.name).filter(Boolean);
  } catch (_) { _marCoordinatorNames = []; }
}

// Data-only refresh (used by the shell + autosave). Returns the record list.
export async function loadCouplesData() {
  await Promise.all([loadTemplates(), loadMarriageCoordinator()]);
  const { data, error } = await sb.from('couples').select('*');
  if (error) { console.error('[marriage]', error); return []; }
  allCouples = data || [];
  store.allCouples = allCouples;
  updateCoupleStats();
  renderMarriageAlerts();
  return allCouples;
}

// Nav loader — fetch then mount the master-detail shell into #couples-list.
export async function loadCouples() {
  await loadCouplesData();
  const gear = document.getElementById('marriage-gear');
  if (gear) gear.style.display = isSacramentCoordinator('marriage') ? '' : 'none';
  const root = document.getElementById('couples-list');
  if (!root) return;
  const { marriageConfig } = await import('../sacramental/marriageConfig.js');
  renderSacramentalPanel(root, marriageConfig);
}

// ── Shell accessors (consumed by marriageConfig) ─────────────────────────────
export function getCouples() { return allCouples; }
export function getCouple(id) { return allCouples.find(x => x.id === id) || null; }
export { fullAccess as marCanManage };
export { MTYPE_BADGE, marType, coupleLabel, s1Name, s2Name, normDocs, normSteps, normFees, notesOf, progressOf, feeTotals };
export function weddingDateOf(c) { return c?.wedding_date || null; }
export function officiantOf(c) {
  if (c?.officiant) return c.officiant;                                  // new shared-helper value
  if (c?.officiant_id) return (store.personnel || []).find(p => p.id === c.officiant_id)?.name || '';  // legacy FK
  return c?.officiant_override || '';                                    // legacy free-text
}
export function preparerOf(c) {
  if (c?.preparer) return c.preparer;
  if (c?.preparation_responsible_id) return (store.personnel || []).find(p => p.id === c.preparation_responsible_id)?.name || '';
  return c?.preparation_responsible_override || '';
}
export function weddingChurch(c) {
  if (c?.wedding_institution_id) return (store.institutions || []).find(i => i.id === c.wedding_institution_id)?.name || '';
  return c?.wedding_church_override || '';
}

function updateCoupleStats() {
  const active = allCouples.filter(c => !c.archived);
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('stat-couples', active.length);
  set('stat-nearly', active.filter(c => c.status_code === 'complete').length);
  set('stat-needs-attention', active.filter(c => c.status_code === 'inprogress').length);
}

function renderMarriageAlerts() {
  const el = document.getElementById('marriage-alerts'); if (!el) return;
  const urgent = allCouples.filter(p => {
    if (p.archived || p.status_code === 'inactive') return false;
    const days = daysUntil(p.wedding_date);
    const docs = normDocs(p);
    return (days !== null && days <= 30 && docs.some(d => !d.received)) || (days !== null && days <= 7) || hasDelegationFlag(p);
  });
  if (!urgent.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="alert-strip" style="margin-bottom:1rem;flex-direction:column;align-items:flex-start;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><i class="ti ti-alert-triangle" style="color:var(--gold);font-size:15px;"></i><strong style="font-size:13px;">Priority actions</strong></div>
    ${urgent.map(p => {
      const days = daysUntil(p.wedding_date);
      const ds = days === 0 ? 'TODAY' : days === 1 ? 'tomorrow' : `${days} days`;
      const out = normDocs(p).filter(d => !d.received).map(d => d.name);
      const deleg = hasDelegationFlag(p) ? ' · ⚠️ send letter of delegation' : '';
      return `<div style="font-size:13px;color:var(--navy);margin-bottom:3px;">· <strong>${_esc(coupleLabel(p))}</strong>${days !== null ? ' — wedding ' + ds : ''}${out.length ? ' · outstanding: ' + out.slice(0, 3).join(', ') + (out.length > 3 ? ` +${out.length - 3} more` : '') : ''}${deleg}</div>`;
    }).join('')}
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
  const { error } = await sb.from('couples').update({ ...patch, updated_at: nowIso() }).eq('id', coupleId);
  if (error) { alert('Save failed: ' + error.message); return null; }
  Object.assign(c, patch);
  return c;
}
async function toggleCoupleDoc(coupleId, i) {
  const c = allCouples.find(x => x.id === coupleId); if (!c) return;
  const docs = normDocs(c); docs[i].received = !docs[i].received;
  if (await _patch(coupleId, { documents: docs })) refreshActivePanel();
}
async function toggleCoupleStep(coupleId, i) {
  const c = allCouples.find(x => x.id === coupleId); if (!c) return;
  const steps = JSON.parse(JSON.stringify(normSteps(c)));
  const done = !steps[i].completed;
  steps[i].completed = done;
  steps[i].completed_date = done ? nowIso() : null;
  steps[i].completed_by = done ? _curUserName() : null;
  if (await _patch(coupleId, { steps })) refreshActivePanel();
}
async function toggleCoupleFee(coupleId, i) {
  const c = allCouples.find(x => x.id === coupleId); if (!c) return;
  const fees = JSON.parse(JSON.stringify(normFees(c)));
  fees[i].paid = !fees[i].paid;
  fees[i].paid_date = fees[i].paid ? nowIso() : null;
  if (await _patch(coupleId, { fees })) refreshActivePanel();
}
async function addCoupleNoteLog(coupleId) {
  const inp = document.getElementById('cn-' + coupleId); const note = (inp?.value || '').trim();
  if (!note) return;
  const c = allCouples.find(x => x.id === coupleId); if (!c) return;
  const log = Array.isArray(c.notes_log) ? JSON.parse(JSON.stringify(c.notes_log)) : [];
  log.push({ note, by: _curUserName(), created_at: nowIso() });
  if (await _patch(coupleId, { notes_log: log })) refreshActivePanel();
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
  // default person responsible from program_coordinators
  let coordId = null;
  try {
    const { data } = await sb.from('program_coordinators').select('coordinator_ids').eq('program', 'marriage').maybeSingle();
    coordId = data?.coordinator_ids?.[0] || null;
  } catch (_) {}
  _M = newModalState(null, type, coordId);
  _marOpen(buildCoupleModalHtml(null));
  _hydrateModal();
}

function openCoupleEdit(id) {
  const c = allCouples.find(x => x.id === id); if (!c) return;
  _M = newModalState(c, marType(c), c.preparation_responsible_id || null);
  _marOpen(buildCoupleModalHtml(c));
  _hydrateModal();
}

function newModalState(c, type, coordId) {
  return {
    id: c?.id || null, isEdit: !!c, type, external: !!c?.is_external,
    respId: c?.preparation_responsible_id || coordId || '', respOther: !c?.preparation_responsible_id && !!c?.preparation_responsible_override,
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
function _ociaLabel(id) { const r = (store.allOcia || []).find(x => x.id === id); return r ? (r.name || 'OCIA record') : 'OCIA record'; }
function _caseLabel(id) { const r = (store.allCases || []).find(x => x.id === id); return r ? `${r.petitioner || ''}${r.respondent ? ' v. ' + r.respondent : ''}` : 'Annulment case'; }

function buildCoupleModalHtml(c, opts = {}) {
  const inline = !!opts.inline;
  const isEdit = _M.isEdit;
  const respOpts = clergyPersonnel().map(p => `<option value="${p.id}"${_M.respId === p.id ? ' selected' : ''}>${_esc(p.name)}</option>`).join('');
  const instOpts = (store.institutions || []).map(inst => `<option value="${inst.id}"${c?.wedding_institution_id === inst.id ? ' selected' : ''}>${_esc(inst.name)}</option>`).join('');

  let h = inline ? '' : `<div class="modal-title">${isEdit ? 'Edit Marriage File' : 'New Marriage File'}</div>`;

  // Section 1 — Person responsible + External
  h += _sectionHead('Person Responsible');
  h += `<label>Person Responsible</label>
    <select id="mf-resp" onchange="marOnRespChange(this.value)">
      <option value="">— Select —</option>${respOpts}<option value="__other"${_M.respOther ? ' selected' : ''}>Other…</option>
    </select>
    <div id="mf-resp-other-wrap" style="display:${_M.respOther ? 'block' : 'none'};">${_input('mf-resp-other', 'Name', c?.preparation_responsible_override || '')}</div>`;

  // Section 1b — Preparer (clergy-aware: institution clergy + marriage coordinator + Other)
  h += _sectionHead('Preparer');
  h += buildPreparerField('mf-preparer', c?.preparer || '', { coordinatorNames: _marCoordinatorNames });

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
  h += `<label>Church of Marriage</label>
    <select id="mf-inst" onchange="marOnInstitutionChange(this.value)">
      <option value="">— Select —</option>${instOpts}<option value="__other"${_M.instMode === 'other' ? ' selected' : ''}>Other…</option>
    </select>
    <div id="mf-inst-other-wrap" style="display:${_M.instMode === 'other' ? 'block' : 'none'};">${_input('mf-church-override', 'Church name', c?.wedding_church_override || '')}</div>
    ${_row(_input('mf-wcity', 'City', c?.wedding_city || ''), _stateSelect('mf-wstate', c?.wedding_state || ''))}`;
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

  // Edit-only
  if (isEdit) {
    h += _sectionHead('Status');
    h += `<label>Status</label><select id="mf-status">${Object.entries(COUPLE_STATUS).map(([k, v]) => `<option value="${k}"${(c?.status_code || 'inprogress') === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`;
    h += _toggle('mf-archive', 'Archive this file', !!c?.archived);
  }

  if (!inline) {
    h += `<div class="modal-actions" style="justify-content:space-between;">
      ${isEdit ? `<button class="btn-delete" onclick="marDeleteCouple('${_M.id}')">Delete</button>` : '<span></span>'}
      <div style="display:flex;gap:8px;"><button class="btn-secondary" onclick="marCloseModal()">Cancel</button><button class="btn-primary" onclick="marSaveCouple()">${isEdit ? 'Save' : 'Create File'}</button></div>
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
  h += _input(`mf-${p}-dob`, 'Date of Birth', c?.[`spouse${n}_dob`] || '', 'date');
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
  h += `<div id="mf-${p}-baptism-wrap" style="display:${s.unbaptized ? 'none' : 'block'};">${_row(_input(`mf-${p}-bchurch`, 'Church of Baptism', c?.[`spouse${n}_baptism_church`] || ''), _input(`mf-${p}-bcity`, 'City', c?.[`spouse${n}_baptism_city`] || ''), _input(`mf-${p}-bstate`, 'State/Country', c?.[`spouse${n}_baptism_state`] || ''))}</div>`;
  // Prior marriages
  h += `<div style="margin-top:.75rem;">${_toggle(`mf-${p}-priortoggle`, 'Prior Marriage?', _M[`${p}Prior`].length > 0, `marPriorToggle(${n})`)}
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
      <span style="flex:1;font-size:13px;color:var(--navy);">${_esc(d.name)}</span>
      <button onclick="marRemoveDoc(${i})" title="Remove" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>
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
function marOnRespChange(v) { _M.respOther = v === '__other'; document.getElementById('mf-resp-other-wrap').style.display = _M.respOther ? 'block' : 'none'; }
function marOnExternalToggle() {
  _M.external = document.getElementById('mf-external').checked;
  // External only removes Documents + Steps of Preparation; Type, Wedding Details, Fees stay.
  ['mf-docs-section', 'mf-steps-section'].forEach(id => { const e = document.getElementById(id); if (e) e.style.display = _M.external ? 'none' : 'block'; });
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
  document.getElementById('mf-inst-other-wrap').style.display = _M.instMode === 'other' ? 'block' : 'none';
  const cityEl = document.getElementById('mf-wcity'), stateEl = document.getElementById('mf-wstate');
  if (_M.instMode === 'inst') {
    const inst = (store.institutions || []).find(x => x.id === v);
    const cs = parseCityState(inst?.address || '');
    if (cityEl) { cityEl.value = cs.city || cityEl.value; cityEl.readOnly = true; cityEl.style.background = '#F0EDE8'; }
    if (stateEl) { if (cs.state) stateEl.value = cs.state; stateEl.disabled = true; stateEl.style.background = '#F0EDE8'; }
  } else {
    if (cityEl) { cityEl.readOnly = false; cityEl.style.background = '#fff'; }
    if (stateEl) { stateEl.disabled = false; stateEl.style.background = '#fff'; }
  }
}
function parseCityState(addr) {
  if (!addr) return {};
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return {};
  const city = parts[parts.length - 2];
  const stateZip = parts[parts.length - 1].split(/\s+/);
  const state = US_STATES.includes(stateZip[0]) ? stateZip[0] : '';
  return { city, state };
}
// Show the Delegation toggle only when the officiant is a free-text "Other".
function marOnOfficiantOtherToggle() { const w = document.getElementById('mf-delegation-wrap'); if (w) w.style.display = officiantIsOther('mf-officiant') ? 'block' : 'none'; }

function marSpouseToggle(n) {
  const p = n === 1 ? 's1' : 's2';
  const s = _M[`s${n}`];
  s.unbaptized = document.getElementById(`mf-${p}-unbap`).checked;
  s.nonCatholic = document.getElementById(`mf-${p}-noncath`)?.checked || false;
  s.inOcia = document.getElementById(`mf-${p}-inocia`)?.checked || false;
  document.getElementById(`mf-${p}-noncath-wrap`).style.display = s.unbaptized ? 'none' : 'block';
  document.getElementById(`mf-${p}-baptism-wrap`).style.display = s.unbaptized ? 'none' : 'block';
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

function marDocReceived(i, v) { _M.docs[i].received = v; }
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
  const respSel = _v('mf-resp') || document.getElementById('mf-resp')?.value || '';
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
    preparation_responsible_id: respSel && respSel !== '__other' ? respSel : null,
    preparation_responsible_override: respSel === '__other' ? (_v('mf-resp-other') || null) : null,
    marriage_type: _M.type,
    civil_marriage_date: (_M.type === 'convalidation' || _M.type === 'sanatio') ? (_v('mf-civil-date') || null) : null,
    sanatio_faculty: _M.type === 'sanatio' ? (_v('mf-faculty') || null) : null,
    spouse1_first: s1first || null, spouse1_middle: _v('mf-s1-middle') || null, spouse1_last: s1last || null, spouse1_dob: _v('mf-s1-dob') || null,
    spouse1_unbaptized: _M.s1.unbaptized, spouse1_non_catholic: !_M.s1.unbaptized && _M.s1.nonCatholic, spouse1_in_ocia: _M.s1.inOcia, spouse1_ocia_id: _M.s1.ocia?.id || null,
    spouse1_baptism_church: _M.s1.unbaptized ? null : (_v('mf-s1-bchurch') || null), spouse1_baptism_city: _M.s1.unbaptized ? null : (_v('mf-s1-bcity') || null), spouse1_baptism_state: _M.s1.unbaptized ? null : (_v('mf-s1-bstate') || null),
    spouse1_prior_marriages: _M.s1Prior,
    spouse2_first: s2first || null, spouse2_middle: _v('mf-s2-middle') || null, spouse2_last: s2last || null, spouse2_dob: _v('mf-s2-dob') || null,
    spouse2_unbaptized: _M.s2.unbaptized, spouse2_non_catholic: !_M.s2.unbaptized && _M.s2.nonCatholic, spouse2_in_ocia: _M.s2.inOcia, spouse2_ocia_id: _M.s2.ocia?.id || null,
    spouse2_baptism_church: _M.s2.unbaptized ? null : (_v('mf-s2-bchurch') || null), spouse2_baptism_city: _M.s2.unbaptized ? null : (_v('mf-s2-bcity') || null), spouse2_baptism_state: _M.s2.unbaptized ? null : (_v('mf-s2-bstate') || null),
    spouse2_prior_marriages: _M.s2Prior,
    // contact fields (legacy columns)
    groom_phone: normalizePhone(_v('mf-s1-cell')) || null, groom_email: _v('mf-s1-email') || null,
    bride_phone: normalizePhone(_v('mf-s2-cell')) || null, bride_email: _v('mf-s2-email') || null,
    // wedding details (kept for external)
    wedding_date: _v('mf-wd') || null,
    wedding_time: _M.nonChurch ? null : (_v('mf-wt') || null),
    non_church_wedding: _M.nonChurch,
    wedding_institution_id: (instSel && instSel !== '__other') ? instSel : null,
    wedding_church_override: instSel === '__other' ? (_v('mf-church-override') || null) : null,
    wedding_city: _v('mf-wcity') || null,
    wedding_state: _v('mf-wstate') || null,
    // Officiant + preparer via the shared clergy helpers (name strings).
    officiant: readOfficiantValue('mf-officiant'),
    delegation_given: officiantIsOther('mf-officiant') ? _chk('mf-delegation') : false,
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
  const { payload, external, prior } = r;
  payload.status_code = external ? 'external' : (document.getElementById('mf-status')?.value || prior?.status_code || 'inprogress');
  payload.archived = _chk('mf-archive');
  const { error } = await sb.from('couples').update(payload).eq('id', id);
  if (error) { reportWriteError('couples update', error); return { ok: false }; }
  logActivity({ action: 'updated marriage prep record', entityType: 'marriage', entityName: `${payload.groom} & ${payload.bride}`, contextType: 'couple', contextId: id });
  await loadCouplesData();
  return { ok: true };
}

// Create modal save.
async function marSaveCouple() {
  const r = _marReadPayload();
  if (!r.ok) { alert('At least one spouse name is required.'); return; }
  if (_M.isEdit) { const res = await _marWriteEdit(_M.id); if (res.ok) { marCloseModal(); refreshActivePanel(); } return; }
  const { payload, external } = r;
  payload.status_code = external ? 'external' : 'inprogress';
  payload.archived = false;
  const { error } = await sb.from('couples').insert(payload);
  if (error) { reportWriteError('couples insert', error); return; }
  logActivity({ action: 'created marriage prep record', entityType: 'marriage', entityName: `${payload.groom} & ${payload.bride}`, contextType: 'couple' });
  marCloseModal(); await loadCouplesData(); refreshActivePanel();
}

// ── Shell config hooks (inline edit form + save/delete/bulk) ─────────────────
export function buildMarEditForm(c) {
  _M = newModalState(c, marType(c), c?.preparation_responsible_id || null);
  const html = buildCoupleModalHtml(c, { inline: true });
  setTimeout(() => _hydrateModal(), 0);
  return html;
}
export async function marSaveEdit(id) { return _marWriteEdit(id); }
export async function marDeleteRec(id) {
  if (!confirm('Permanently delete this file? This cannot be undone.')) return { ok: false };
  const { error } = await sb.from('couples').delete().eq('id', id);
  if (error) { reportWriteError('couples delete', error); return { ok: false }; }
  allCouples = allCouples.filter(x => x.id !== id);
  logActivity({ action: 'deleted marriage prep record', entityType: 'marriage', entityName: id, contextType: 'couple' });
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
  const { error } = await sb.from('couples').delete().eq('id', id);
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
  const btn = document.querySelector('#mar-overlay .modal-actions .btn-primary');
  if (btn) { btn.textContent = 'Saved ✓'; btn.style.background = '#2D6A4F'; setTimeout(() => { btn.textContent = 'Save Template'; btn.style.background = ''; }, 1600); }
}

Object.assign(window, {
  openCoupleAdd, openCoupleEdit,
  toggleCoupleDoc, toggleCoupleStep, toggleCoupleFee, addCoupleNoteLog,
  marCloseModal, marSaveCouple, marDeleteCouple,
  marOnRespChange, marOnExternalToggle, marOnTypeChange, marOnNonChurchToggle, marOnInstitutionChange, marOnOfficiantOtherToggle,
  marSpouseToggle, marPriorToggle, marAddPrior, marRemovePrior, marPriorEndedChange,
  marOciaSearch, marRemoveOcia, marAnnulSearch, marRemoveAnnul,
  marDocReceived, marRemoveDoc, marAddDoc, marAddStep, marRemoveStep, marStepDragStart, marStepDrop, marAddFee, marRemoveFee, marFeePaid,
  openMarriageTemplates, marTplTab, marTplAddDoc, marTplRemoveDoc, marTplAddStep, marTplRemoveStep, marTplFeesEnabled, marTplAddFee, marTplRemoveFee, marTplSave,
  expandCase, expandCouple,
});
