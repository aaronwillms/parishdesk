import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, formatDateDisplay, todayCST, logActivity, isPersonClergy } from '../utils.js';
import { isAdmin, canAccessSacrament, isSacramentCoordinator } from '../roles.js';
import { notifyUsers, getUserIdsForSacrament } from '../notifications.js';

const CONF_STATUS = {
  enrolled:    { label:'Enrolled',             color:'#4A1D96', bg:'#EDE9FE', dot:'#7C3AED' },
  preparation: { label:'In Preparation',       color:'#7D6608', bg:'#FEF9E7', dot:'#D4AC0D' },
  complete:    { label:'Preparation Complete', color:'#2D6A4F', bg:'#D8F3DC', dot:'#2D6A4F' },
  confirmed:   { label:'Confirmed',            color:'#1B4F72', bg:'#D6EAF8', dot:'#1B4F72' },
  inactive:    { label:'Inactive',             color:'#616A6B', bg:'#F2F3F4', dot:'#AAB7B8' },
};
const GRADES = ['K', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', 'Other'];
const COUNTRIES = ['United States of America', 'Mexico', 'Philippines', 'Vietnam', 'Nigeria', 'India', 'Other'];
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
const CLERGY_TYPES = ['pastor', 'parochial-vicar', 'priest-in-residence', 'deacon', 'religious'];
const CLERGY_TITLE_RE = /^(fr\.|rev\.|deacon|msgr\.|bishop|archbishop|cardinal)/i;
const FALLBACK_TEMPLATES = {
  youth: { documents: [{ name: 'Baptismal Certificate', deletable: false }, { name: 'Petition to Bishop', deletable: true }], service_hours_enabled: false, service_hours_required: 20 },
  adult: { documents: [{ name: 'Baptismal Certificate', deletable: false }, { name: 'Petition to Bishop', deletable: true }], service_hours_enabled: false, service_hours_required: 20 },
};

let allConf = [], confFilter = 'all', confExpanded = null, _cohortFilter = 'all';
let _cohorts = [], _templates = {}, _M = null;

function fullAccess() { return isAdmin() || canAccessSacrament('confirmation'); }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _curUserName() { return store.currentUserProfile?.personnel?.name || 'Staff'; }
function nowIso() { return new Date().toISOString(); }
function clergyPersonnel() { return (store.personnel || []).filter(p => isPersonClergy(p.id)).sort((a, b) => (a.name || '').localeCompare(b.name || '')); }
function ageOf(dob) { if (!dob) return null; const d = new Date(dob); if (isNaN(d)) return null; const now = new Date(new Date().toLocaleString('en-US', { timeZone: store.parishSettings?.timezone || 'America/Chicago' })); let a = now.getFullYear() - d.getFullYear(); const m = now.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--; return a; }
function cohortLabel(dateStr) { if (!dateStr) return 'No date'; const d = new Date(dateStr + 'T00:00:00'); return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }

// ── Field accessors (backward-compatible) ────────────────────────────────────
function nameOf(p) { return (p.first_name || p.last_name) ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : (p.name || '—'); }
function lastNameOf(p) { if (p.last_name) return p.last_name; const parts = (p.name || '').trim().split(/\s+/); return parts[parts.length - 1] || ''; }
function statusOf(p) { return p.status_code || 'enrolled'; }
function tmplType(p) { return p.template_type || 'youth'; }
function confDate(p) { return p ? (p.confirmation_date || p.sacrament_date || null) : null; }
function normDocs(p) { return (p.documents || []).map(d => ({ name: d.name, received: d.received ?? d.done ?? false, deletable: d.deletable ?? !d.auto, auto: !!d.auto })); }
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
export async function loadConfirmation() {
  await Promise.all([loadTemplates(), loadCohorts()]);
  const { data, error } = await sb.from('sacramental_confirmation').select('*').order('created_at', { ascending: false });
  if (error) { console.error('[confirmation]', error); return; }
  allConf = data || [];
  store.allConfirmation = allConf;
  renderAll();
  updateStats();
}
function updateStats() {
  const active = allConf.filter(p => !p.archived && statusOf(p) !== 'inactive');
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('stat-con-total', active.length);
  set('stat-con-upcoming', active.filter(p => confDate(p) && confDate(p) >= todayCST()).length);
  set('stat-con-docs', active.filter(p => normDocs(p).some(d => !d.received)).length);
}

// ── Panel chrome ─────────────────────────────────────────────────────────────
function renderAll() {
  const root = document.getElementById('confirmation-root'); if (!root) return;
  const manage = fullAccess();
  const filters = [['all', 'All'], ['enrolled', 'Enrolled'], ['preparation', 'In Preparation'], ['complete', 'Preparation Complete'], ['confirmed', 'Confirmed'], ['inactive', 'Inactive']]
    .map(([k, l]) => `<button class="cf-btn${confFilter === k ? ' active' : ''}" onclick="setConfFilter('${k}',this)">${l}</button>`).join('');
  const cohortOpts = `<option value="all"${_cohortFilter === 'all' ? ' selected' : ''}>All Cohorts</option>`
    + _cohorts.map(c => `<option value="${c.id}"${_cohortFilter === c.id ? ' selected' : ''}>${cohortLabel(c.cohort_date)}</option>`).join('')
    + `<option value="__manage">⚙ Manage Cohorts…</option>`;

  root.innerHTML = `
    <div class="card" style="padding:.875rem 1.25rem;">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <input type="text" id="con-search" placeholder="Search by name…" oninput="renderConfList()" style="flex:1;min-width:140px;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;" />
        <select id="con-cohort" onchange="confCohortChange(this.value)" style="border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;">${cohortOpts}</select>
        ${isSacramentCoordinator('confirmation') ? `<button class="anl-icon-btn" title="Document templates" onclick="openConfTemplates()"><i class="fa-solid fa-gear"></i></button>` : ''}
        ${manage ? `<button class="btn-primary" style="white-space:nowrap;" onclick="openConfCreate()">+ Add Candidate</button>` : ''}
      </div>
      <div style="display:flex;gap:6px;margin-top:.75rem;flex-wrap:wrap;">${filters}</div>
    </div>
    <div id="con-list"></div>`;
  renderConfList();
}

function setConfFilter(f, el) { confFilter = f; document.querySelectorAll('#panel-confirmation .cf-btn').forEach(b => b.classList.remove('active')); el?.classList.add('active'); renderConfList(); }
function confCohortChange(v) { if (v === '__manage') { document.getElementById('con-cohort').value = _cohortFilter; openCohortManager(); return; } _cohortFilter = v; renderConfList(); }

function renderConfList() {
  const el = document.getElementById('con-list'); if (!el) return;
  const q = (document.getElementById('con-search')?.value || '').toLowerCase();
  let items = allConf.filter(p => {
    if (confFilter !== 'all' && statusOf(p) !== confFilter) return false;
    if (_cohortFilter !== 'all' && (p.cohort_id || '') !== _cohortFilter) return false;
    return !q || nameOf(p).toLowerCase().includes(q);
  });
  if (!items.length) { el.innerHTML = '<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No candidates match.</div>'; return; }
  const active = items.filter(p => !p.archived), archived = items.filter(p => p.archived);

  // group by cohort
  const renderCohortGroups = (list) => {
    const byCohort = {};
    list.forEach(p => { const k = p.cohort_id || '__none'; (byCohort[k] = byCohort[k] || []).push(p); });
    const keys = Object.keys(byCohort).sort((a, b) => {
      const ca = _cohorts.find(c => c.id === a), cb = _cohorts.find(c => c.id === b);
      const da = ca?.cohort_date || '', db = cb?.cohort_date || '';
      if (a === '__none') return 1; if (b === '__none') return -1;
      return (db || '').localeCompare(da || '');
    });
    return keys.map(k => {
      const coh = _cohorts.find(c => c.id === k);
      const header = k === '__none' ? 'No Cohort' : cohortLabel(coh?.cohort_date) + (coh?.church_override || coh?.church_institution_id ? ` · ${_esc(cohortChurchName(coh))}` : '');
      return `<div style="display:flex;align-items:center;gap:10px;margin:16px 0 8px;"><span style="font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#7D6608;">🎓 ${_esc(header)}</span><div style="flex:1;height:.5px;background:var(--stone);"></div></div>`
        + familyOrder(byCohort[k]).map(renderConfCard).join('');
    }).join('');
  };
  let html = renderCohortGroups(active);
  if (archived.length) {
    html += `<div style="display:flex;align-items:center;gap:10px;margin:18px 0 10px;"><div style="flex:1;height:.5px;background:var(--stone);"></div><span style="font-size:11px;color:#6B7280;letter-spacing:.07em;text-transform:uppercase;font-weight:500;">Archived</span><div style="flex:1;height:.5px;background:var(--stone);"></div></div>`;
    html += familyOrder(archived).map(renderConfCard).join('');
  }
  el.innerHTML = html;
}
function cohortChurchName(coh) {
  if (!coh) return '';
  if (coh.church_institution_id) { const i = (store.institutions || []).find(x => x.id === coh.church_institution_id); if (i) return i.name; }
  return coh.church_override || '';
}
function familyOrder(list) {
  // Alphabetical by last name; family members stay grouped (oldest→youngest)
  // and the unit sorts by the family's last name.
  const groups = {}; list.forEach(p => { if (p.family_group_id) (groups[p.family_group_id] = groups[p.family_group_id] || []).push(p); });
  const seen = new Set(); const units = [];
  list.forEach(p => {
    if (p.family_group_id) {
      if (seen.has(p.family_group_id)) return; seen.add(p.family_group_id);
      const members = groups[p.family_group_id].slice().sort((a, b) => (ageOf(b.dob) ?? -1) - (ageOf(a.dob) ?? -1));
      units.push({ members, key: lastNameOf(members[0]).toLowerCase() });
    } else units.push({ members: [p], key: lastNameOf(p).toLowerCase() });
  });
  units.sort((a, b) => a.key.localeCompare(b.key));
  return units.flatMap(u => u.members);
}

// ── Card ─────────────────────────────────────────────────────────────────────
function renderConfCard(p) {
  const sm = CONF_STATUS[statusOf(p)] || CONF_STATUS.enrolled;
  const age = ageOf(p.dob);
  // Only treat as youth/adult when explicitly typed — legacy records have neither.
  const explicitType = !!p.template_type;
  const youth = p.template_type === 'youth';
  const minorFlag = youth && !p.parent_permission_granted;
  const svcFlag = svcIncomplete(p);
  const exp = confExpanded === p.id;
  const fam = p.family_group_id ? `${lastNameOf(p)} Family` : null;
  const docs = normDocs(p); const done = docs.filter(d => d.received).length;
  const progress = docs.length ? Math.round((done / docs.length) * 100) : null;
  const cdate = confDate(p);

  let h = `<div class="couple-card${(minorFlag || svcFlag) ? ' urgent' : ''}" id="conf-card-${p.id}" style="border-left:4px solid ${sm.dot};">
    <div class="couple-header" onclick="toggleConf('${p.id}')">
      <div style="flex:1;min-width:0;">
        <span class="couple-name">${_esc(nameOf(p))}${age !== null ? ` <span style="font-size:12px;color:#6B7280;font-weight:400;">(${age})</span>` : ''}</span>
        <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap;align-items:center;">
          <span style="background:${sm.bg};color:${sm.color};border-radius:20px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:.04em;display:inline-flex;align-items:center;gap:5px;border:1px solid ${sm.color}33;"><span style="width:7px;height:7px;border-radius:50%;background:${sm.dot};display:inline-block;"></span>${sm.label}</span>
          ${explicitType ? `<span style="font-size:11px;color:#4A1D96;background:#EDE9FE;border-radius:20px;padding:2px 8px;">${youth ? 'Youth' : 'Adult'}</span>` : ''}
          ${cdate ? `<span style="font-size:11px;background:#FEF9E7;color:#7D6608;border-radius:20px;padding:2px 8px;">🎓 ${cohortLabel(cdate)}</span>` : ''}
          ${fam ? `<span style="font-size:11px;color:#5B4636;background:#F3ECE0;border-radius:20px;padding:2px 8px;">👪 ${_esc(fam)}</span>` : ''}
          ${svcFlag ? `<span style="font-size:11px;color:#922B21;background:#FCEBEB;border-radius:20px;padding:2px 8px;font-weight:600;">⚠️ ${p.service_hours_completed || 0}/${p.service_hours_required} hrs</span>` : ''}
          ${progress !== null ? (progress === 100 ? `<span style="font-size:11px;color:#2D6A4F;">✅ docs complete</span>` : `<span style="font-size:11px;color:#922B21;">${done}/${docs.length} docs</span>`) : ''}
        </div>
        ${minorFlag ? `<div style="margin-top:5px;background:#FEF9E7;border-left:3px solid #D4AC0D;border-radius:3px;padding:4px 10px;font-size:12px;font-weight:600;color:#7D6608;">⚠ Parent/guardian permission outstanding</div>` : ''}
      </div>
      <span style="font-size:16px;color:#B0A090;">${exp ? '▲' : '▼'}</span>
    </div>`;
  if (exp) h += renderConfBody(p, docs, progress, done);
  h += `</div>`;
  return h;
}

function renderConfBody(p, docs, progress, done) {
  let h = `<div class="couple-body">`;
  h += `<div style="margin-top:10px;">`;
  if (p.dob) h += `<span class="detail-chip">🎂 ${_esc(p.dob)}</span>`;
  const grade = p.grade_level || p.grade;
  if (grade) h += `<span class="detail-chip">Grade ${_esc(grade)}</span>`;
  if (p.school_name) h += `<span class="detail-chip">🏫 ${_esc(p.school_name)}</span>`;
  if (p.confirmation_name) h += `<span class="detail-chip">✝ ${_esc(p.confirmation_name)}</span>`;
  h += `</div>`;
  // contact
  const phone = p.candidate_phone || p.phone, email = p.candidate_email || p.email;
  if (phone || email) { h += `<div style="margin-top:8px;">`; if (phone) h += `<a href="tel:${phone}" class="contact-chip">📞 ${_esc(phone)}</a>`; if (email) h += `<a href="mailto:${email}" class="contact-chip">✉️ ${_esc(email)}</a>`; h += `</div>`; }
  // parent
  const parentName = p.parent_name || p.parent1;
  if (parentName) {
    h += `<div class="couple-section-label">Parent / Guardian</div><div style="font-size:13px;">${_esc(parentName)}${p.parent_phone ? ' · ' + _esc(p.parent_phone) : ''}${p.parent_email ? ' · ' + _esc(p.parent_email) : ''}</div>`;
    if (tmplType(p) === 'youth') h += p.parent_permission_granted ? `<div style="font-size:12px;color:#2D6A4F;margin-top:3px;">✅ Permission granted${p.parent_permission_date ? ' ' + formatDateDisplay(p.parent_permission_date) : ''}</div>` : `<div style="font-size:12px;color:#854F0B;margin-top:3px;">⚠ Permission outstanding</div>`;
  }
  // sponsor + confirmation details
  const sponsor = p.sponsor_name || p.sponsor;
  if (sponsor) h += `<div style="font-size:13px;margin-top:6px;">Sponsor: <strong>${_esc(sponsor)}</strong></div>`;
  if (confDate(p) || p.confirmation_location) h += `<div style="font-size:13px;margin-top:4px;">Confirmation: <strong>${confDate(p) ? formatDateDisplay(confDate(p)) : ''}</strong>${p.confirmation_location ? ' · ' + _esc(p.confirmation_location) : ''}</div>`;
  // service hours
  if (svcEnabled(p)) {
    const pct = Math.min(100, Math.round(((p.service_hours_completed || 0) / p.service_hours_required) * 100));
    h += `<div class="couple-section-label" style="margin-top:10px;">Service hours — ${p.service_hours_completed || 0} of ${p.service_hours_required}</div><div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${pct}%;background:${pct === 100 ? '#2D6A4F' : 'var(--gold)'};"></div></div>`;
  }
  // documents
  if (docs.length) {
    h += `<div class="couple-section-label" style="margin-top:12px;">Document checklist</div>`;
    if (progress !== null) h += `<div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${progress}%;background:${progress === 100 ? '#2D6A4F' : 'var(--gold)'};"></div></div><div style="font-size:11px;color:#888;margin-bottom:6px;">${done}/${docs.length} received</div>`;
    h += docs.map((d, i) => `<div class="doc-item" style="padding:4px 6px;display:flex;align-items:center;gap:8px;">
      <span style="font-size:15px;cursor:pointer;" onclick="toggleConfDoc('${p.id}',${i})">${d.received ? '✅' : '⬜'}</span>
      <span style="flex:1;color:${d.received ? '#2D6A4F' : 'var(--navy)'};cursor:pointer;" onclick="toggleConfDoc('${p.id}',${i})">${_esc(d.name)}</span>
      ${!d.deletable ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required"></i>` : ''}
    </div>`).join('');
  }
  // notes
  const notes = notesOf(p);
  h += `<div class="couple-section-label" style="margin-top:12px;">Notes</div>
    <div style="display:flex;gap:6px;margin-bottom:8px;"><input type="text" id="cfn-${p.id}" placeholder="Add a note…" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();addConfNote('${p.id}');}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="addConfNote('${p.id}')">Add</button></div>`;
  h += notes.length ? notes.map(n => `<div style="font-size:13px;color:#555;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;"><div style="white-space:pre-wrap;">${_esc(n.note)}</div>${(n.by || n.created_at) ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${n.created_at ? fmtDate(String(n.created_at).slice(0, 10)) : ''}${n.by ? ' · ' + _esc(n.by) : ''}</div>` : ''}</div>`).join('') : `<div style="font-size:13px;color:#9CA3AF;font-style:italic;padding:.25rem 0;">No notes yet.</div>`;

  h += `<div style="margin-top:12px;text-align:right;"><button class="anl-icon-btn" title="Edit" onclick="openConfEdit('${p.id}')"><i class="fa-solid fa-pencil"></i></button></div></div>`;
  return h;
}

function toggleConf(id) { confExpanded = confExpanded === id ? null : id; renderConfList(); }
export async function expandConfirmation(id) {
  confExpanded = id; window.switchPanel('confirmation'); await loadConfirmation();
  document.getElementById('conf-card-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Autosave ─────────────────────────────────────────────────────────────────
async function _patch(id, patch) { const p = allConf.find(x => x.id === id); if (!p) return null; const { error } = await sb.from('sacramental_confirmation').update({ ...patch, updated_at: nowIso() }).eq('id', id); if (error) { alert('Save failed: ' + error.message); return null; } Object.assign(p, patch); return p; }
async function toggleConfDoc(id, i) {
  const p = allConf.find(x => x.id === id); if (!p) return;
  const docs = normDocs(p); docs[i].received = !docs[i].received;
  const prevAll = normDocs(p).length > 0 && normDocs(p).every(d => d.received);
  const allDone = docs.length > 0 && docs.every(d => d.received);
  const patch = { documents: docs };
  if (allDone && !prevAll) { const tl = JSON.parse(JSON.stringify(p.timeline || [])); tl.push({ type: 'auto', text: 'All documents received', created_at: nowIso() }); patch.timeline = tl; }
  if (await _patch(id, patch)) { renderConfList(); updateStats(); }
}
async function addConfNote(id) {
  const inp = document.getElementById('cfn-' + id); const note = (inp?.value || '').trim(); if (!note) return;
  const p = allConf.find(x => x.id === id); if (!p) return;
  const log = Array.isArray(p.notes_log) ? JSON.parse(JSON.stringify(p.notes_log)) : [];
  log.push({ note, by: _curUserName(), created_at: nowIso() });
  if (await _patch(id, { notes_log: log })) renderConfList();
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

// ── Create / Edit ────────────────────────────────────────────────────────────
async function openConfCreate() {
  let coordId = null;
  try { const { data } = await sb.from('program_coordinators').select('coordinator_ids').eq('program', 'confirmation').maybeSingle(); coordId = data?.coordinator_ids?.[0] || null; } catch (_) {}
  _M = newModalState(null, 'youth', coordId);
  _confOpen(buildModalHtml(null)); _hydrate();
}
function openConfEdit(id) { const p = allConf.find(x => x.id === id); if (!p) return; _M = newModalState(p, tmplType(p), p.preparation_responsible_id || null); _confOpen(buildModalHtml(p)); _hydrate(); }
function newModalState(p, type, coordId) {
  return {
    id: p?.id || null, isEdit: !!p, type,
    respId: p?.preparation_responsible_id || coordId || '', respOther: !p?.preparation_responsible_id && !!p?.preparation_responsible_override,
    docs: p ? normDocs(p) : computeTemplateDocs(type),
    family: p?.family_group_id ? { group_id: p.family_group_id, label: `${lastNameOf(p)} Family` } : null,
  };
}
function computeTemplateDocs(type) { return (_templates[type]?.documents || FALLBACK_TEMPLATES[type].documents).map(d => ({ name: d.name, received: false, deletable: d.deletable ?? true, auto: d.deletable === false })); }
function _nameParts(p) { return { first: p?.first_name || (p?.name || '').split(/\s+/)[0] || '', middle: p?.middle_name || '', last: p?.last_name || (p?.name || '').split(/\s+/).slice(1).join(' ') || '' }; }
function _caseLabel() { return ''; }

function buildModalHtml(p) {
  const isEdit = _M.isEdit;
  const np = _nameParts(p);
  const age = ageOf(p?.dob);
  const respOpts = clergyPersonnel().map(c => `<option value="${c.id}"${_M.respId === c.id ? ' selected' : ''}>${_esc(c.name)}</option>`).join('');
  const instOpts = (store.institutions || []).map(i => `<option value="${i.id}"${p?.confirmation_institution_id === i.id ? ' selected' : ''}>${_esc(i.name)}</option>`).join('');
  const cohortOpts = _cohorts.map(c => `<option value="${c.id}"${p?.cohort_id === c.id ? ' selected' : ''}>${cohortLabel(c.cohort_date)}</option>`).join('');
  const isMinor = age !== null && age <= 17;
  const isAdultAge = age !== null && age >= 18;

  let h = `<div class="modal-title">${isEdit ? 'Edit Confirmation File' : 'New Confirmation Candidate'}</div>`;

  // 1 — Template type
  h += _sectionHead('Template Type');
  h += `<div style="display:flex;gap:10px;"><button type="button" id="ct-youth" class="sac-type-btn${_M.type === 'youth' ? ' active' : ''}" onclick="confSetType('youth')" style="flex:1;">Youth</button><button type="button" id="ct-adult" class="sac-type-btn${_M.type === 'adult' ? ' active' : ''}" onclick="confSetType('adult')" style="flex:1;">Adult</button></div>
    <div id="cf-adult-note" class="anl-info-box" style="display:${_M.type === 'adult' ? 'block' : 'none'};">For adult candidates who are unbaptized, please use the OCIA panel instead.</div>`;

  // 2 — Cohort
  h += _sectionHead('Cohort');
  h += `<label>Cohort</label><select id="cf-cohort" onchange="confCohortPick(this.value)"><option value="">— None —</option>${cohortOpts}<option value="__new">+ Create new cohort…</option></select>`;

  // 3 — Person responsible
  h += _sectionHead('Person Responsible');
  h += `<label>Person Responsible</label><select id="cf-resp" onchange="confRespChange(this.value)"><option value="">— Select —</option>${respOpts}<option value="__other"${_M.respOther ? ' selected' : ''}>Other…</option></select>
    <div id="cf-resp-other-wrap" style="display:${_M.respOther ? 'block' : 'none'};">${_input('cf-resp-other', 'Name', p?.preparation_responsible_override || '')}</div>`;

  // 4 — Candidate info
  h += _sectionHead('Candidate Information');
  h += _row(_input('cf-first', 'First Name', np.first), _input('cf-middle', 'Middle', np.middle), _input('cf-last', 'Last Name', np.last));
  h += `<label>Date of Birth</label><input type="date" id="cf-dob" value="${(p?.dob && /^\d{4}-\d{2}-\d{2}/.test(p.dob)) ? p.dob.slice(0, 10) : ''}" oninput="confDobChange()" />`;
  h += `<div id="cf-adultage-note" class="anl-info-box" style="display:${isAdultAge ? 'block' : 'none'};">For adult candidates who are unbaptized, please use the OCIA panel instead.</div>`;
  // minor block
  h += `<div id="cf-minor-block" style="display:${isMinor ? 'block' : 'none'};">
    ${_row(`<label>Cell Phone</label><input type="text" id="cf-cell-minor" value="" placeholder="Student is a minor" disabled style="background:#F0EDE8;" />`, _input('cf-email-minor', 'Email', p?.candidate_email || p?.email || ''))}
    ${_row(_input('cf-school', 'School Name', p?.school_name || ''), `<label>Grade Level</label><select id="cf-grade">${GRADES.map(g => `<option${(p?.grade_level || p?.grade) === g ? ' selected' : ''}>${g}</option>`).join('')}</select>`)}
    ${_sectionHead('Parent / Guardian')}
    ${_input('cf-parent-name', 'Parent/Guardian Name', p?.parent_name || p?.parent1 || '')}
    ${_row(_input('cf-parent-phone', 'Cell Phone', p?.parent_phone || ''), _input('cf-parent-email', 'Email', p?.parent_email || ''))}
    ${_toggle('cf-parent-perm', 'Permission Granted', !!p?.parent_permission_granted)}
    ${_input('cf-parent-permdate', 'Date Permission Received', p?.parent_permission_date || '', 'date')}
  </div>`;
  // adult contact block
  h += `<div id="cf-adult-block" style="display:${isMinor ? 'none' : 'block'};">${_row(_input('cf-cell', 'Cell Phone', p?.candidate_phone || p?.phone || ''), _input('cf-email', 'Email', p?.candidate_email || p?.email || ''))}</div>`;

  // 5 — Confirmation details
  h += _sectionHead('Confirmation Details');
  h += _input('cf-confname', 'Confirmation Name', p?.confirmation_name || '');
  h += _input('cf-sponsor', 'Sponsor Name', p?.sponsor_name || p?.sponsor || '');
  h += _input('cf-confdate', 'Confirmation Date', confDate(p) || '', 'date');
  h += `<label>Church</label><select id="cf-church" onchange="confChurchChange(this.value)"><option value="">— Select —</option>${instOpts}<option value="__other"${(p?.confirmation_location && !p?.confirmation_institution_id) ? ' selected' : ''}>Other…</option></select>
    <div id="cf-church-other-wrap" style="display:${(p?.confirmation_location && !p?.confirmation_institution_id) ? 'block' : 'none'};">${_input('cf-church-override', 'Church name', p?.confirmation_location || '')}</div>`;

  // 6 — Baptism
  h += _sectionHead('Baptism Information');
  h += _input('cf-bchurch', 'Church of Baptism', p?.baptism_church || '');
  h += _row(_input('cf-bcity', 'City', p?.baptism_city || ''), _stateSelect('cf-bstate', p?.baptism_state || ''));
  h += `<label>Country</label><select id="cf-bcountry">${COUNTRIES.map(co => `<option${(p?.baptism_country || 'United States of America') === co ? ' selected' : ''}>${co}</option>`).join('')}</select>`;

  // 7 — First communion
  h += _sectionHead('First Communion Information');
  h += _input('cf-fcchurch', 'Church of First Communion', p?.first_communion_church || '');
  h += _row(_input('cf-fccity', 'City', p?.first_communion_city || ''), _stateSelect('cf-fcstate', p?.first_communion_state || ''));
  h += `<label>Country</label><select id="cf-fccountry">${COUNTRIES.map(co => `<option${(p?.first_communion_country || 'United States of America') === co ? ' selected' : ''}>${co}</option>`).join('')}</select>`;

  // 8 — Documents
  h += _sectionHead('Document Checklist');
  h += `<div id="cf-docs"></div><div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="cf-doc-new" placeholder="Add document…" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();confAddDoc();}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="confAddDoc()">+ Add</button></div>`;

  // 9 — Family group (create + edit)
  h += _sectionHead('Family Group');
  h += `<div style="position:relative;"><input type="text" id="cf-family-search" placeholder="Link to family group (search by last name)…" autocomplete="off" oninput="confFamilySearch()" style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" /><div id="cf-family-results" class="anl-link-results" style="display:none;"></div></div><div id="cf-family-chip" style="margin-top:6px;"></div>`;

  if (isEdit) {
    h += _sectionHead('Status');
    h += `<label>Status</label><select id="cf-status">${Object.entries(CONF_STATUS).map(([k, v]) => `<option value="${k}"${statusOf(p) === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`;
    if (_templates[_M.type]?.service_hours_enabled || (p?.service_hours_required || 0) > 0) {
      h += _sectionHead('Service Hours');
      h += _row(_input('cf-svc-done', 'Hours Completed', String(p?.service_hours_completed ?? 0), 'number'), `<label>Hours Required</label><input type="number" value="${p?.service_hours_required ?? _templates[_M.type]?.service_hours_required ?? 20}" readonly style="background:#F0EDE8;" id="cf-svc-req" />`);
    }
    h += _toggle('cf-archive', 'Archive this file', !!p?.archived);
  }

  h += `<div class="modal-actions" style="justify-content:space-between;">
    ${isEdit ? `<button class="btn-delete" onclick="confDeletePerson('${_M.id}')">Delete</button>` : '<span></span>'}
    <div style="display:flex;gap:8px;"><button class="btn-secondary" onclick="confCloseModal()">Cancel</button><button class="btn-primary" onclick="confSave()">${isEdit ? 'Save' : 'Create File'}</button></div>
  </div>`;
  return h;
}

function _hydrate() { renderModalDocs(); renderFamilyChip(); }
function renderModalDocs() {
  const el = document.getElementById('cf-docs'); if (!el) return;
  el.innerHTML = _M.docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
    <input type="checkbox" ${d.received ? 'checked' : ''} onchange="confDocReceived(${i},this.checked)" style="width:15px;height:15px;accent-color:var(--cardinal);" />
    <span style="flex:1;font-size:13px;color:var(--navy);">${_esc(d.name)}</span>
    ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required"></i>` : `<button onclick="confRemoveDoc(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>`}
  </div>`).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No documents.</div>`;
}
function renderFamilyChip() { const el = document.getElementById('cf-family-chip'); if (!el) return; el.innerHTML = _M.family ? `<span style="display:inline-flex;align-items:center;gap:8px;background:#1C2B3A;color:#fff;border-radius:14px;padding:3px 8px 3px 12px;font-size:12px;"><span>${_esc(_M.family.label)}</span><button onclick="confRemoveFamily()" style="background:none;border:none;color:#cdd6df;cursor:pointer;font-size:12px;padding:0;">×</button></span>` : ''; }

// modal handlers
function confSetType(t) {
  _M.type = t;
  document.getElementById('ct-youth').classList.toggle('active', t === 'youth');
  document.getElementById('ct-adult').classList.toggle('active', t === 'adult');
  document.getElementById('cf-adult-note').style.display = t === 'adult' ? 'block' : 'none';
  if (!_M.isEdit) { _M.docs = computeTemplateDocs(t); renderModalDocs(); }
}
function confRespChange(v) { _M.respOther = v === '__other'; document.getElementById('cf-resp-other-wrap').style.display = _M.respOther ? 'block' : 'none'; }
function confCohortPick(v) {
  if (v === '__new') { document.getElementById('cf-cohort').value = ''; openCohortManager(); return; }
  const coh = _cohorts.find(c => c.id === v);
  if (coh && coh.cohort_date) { const dt = document.getElementById('cf-confdate'); if (dt && !dt.value) dt.value = coh.cohort_date; }
}
function confDobChange() {
  const age = ageOf(document.getElementById('cf-dob').value);
  const minor = age !== null && age <= 17, adultAge = age !== null && age >= 18;
  document.getElementById('cf-minor-block').style.display = minor ? 'block' : 'none';
  document.getElementById('cf-adult-block').style.display = minor ? 'none' : 'block';
  document.getElementById('cf-adultage-note').style.display = adultAge ? 'block' : 'none';
}
function confChurchChange(v) {
  const other = v === '__other';
  document.getElementById('cf-church-other-wrap').style.display = other ? 'block' : 'none';
}
function confDocReceived(i, v) { _M.docs[i].received = v; }
function confRemoveDoc(i) { _M.docs.splice(i, 1); renderModalDocs(); }
function confAddDoc() { const inp = document.getElementById('cf-doc-new'); const name = (inp?.value || '').trim(); if (!name) return; _M.docs.push({ name, received: false, deletable: true, auto: false }); inp.value = ''; renderModalDocs(); }
async function confFamilySearch() {
  const q = document.getElementById('cf-family-search')?.value || ''; const box = document.getElementById('cf-family-results'); if (!box) return;
  if (q.trim().length < 2) { box.style.display = 'none'; return; }
  const safe = q.replace(/[%_,()'"*]/g, ' ');
  const { data } = await sb.from('sacramental_confirmation').select('id,name,first_name,last_name,family_group_id').or(`name.ilike.%${safe}%,last_name.ilike.%${safe}%,first_name.ilike.%${safe}%`).limit(6);
  const rows = (data || []);
  box.innerHTML = rows.length ? rows.map(r => `<div class="anl-link-opt" data-id="${r.id}" data-gid="${r.family_group_id || ''}" data-last="${_esc(lastNameOf(r))}">${_esc(nameOf(r))} — ${_esc(lastNameOf(r))} Family</div>`).join('') : `<div style="padding:.5rem .7rem;font-size:12px;color:#9CA3AF;">No matches</div>`;
  box.style.display = 'block';
  box.querySelectorAll('.anl-link-opt').forEach(o => o.addEventListener('mousedown', e => { e.preventDefault(); _M.family = { target_id: o.dataset.id, group_id: o.dataset.gid || null, label: `${o.dataset.last} Family` }; box.style.display = 'none'; document.getElementById('cf-family-search').value = ''; renderFamilyChip(); }));
}
function confRemoveFamily() { _M.family = null; renderFamilyChip(); }

// ── Save ─────────────────────────────────────────────────────────────────────
function _v(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function _chk(id) { return !!document.getElementById(id)?.checked; }
async function confSave() {
  const first = _v('cf-first'), last = _v('cf-last');
  const name = [first, _v('cf-middle'), last].filter(Boolean).join(' ');
  if (!name) { alert('Candidate name is required.'); return; }
  const type = _M.type;
  const age = ageOf(_v('cf-dob'));
  const minor = age !== null && age <= 17;
  const respSel = document.getElementById('cf-resp')?.value || '';
  const cohortSel = document.getElementById('cf-cohort')?.value || '';
  const coh = _cohorts.find(c => c.id === cohortSel);
  const churchSel = document.getElementById('cf-church')?.value || '';

  let familyGroupId = null, linkTarget = null;
  if (_M.family) { if (_M.family.group_id) familyGroupId = _M.family.group_id; else { familyGroupId = (crypto?.randomUUID?.() || String(Date.now())); linkTarget = _M.family.target_id; } }

  const tmpl = _templates[type] || FALLBACK_TEMPLATES[type];
  const payload = {
    name, first_name: first || null, middle_name: _v('cf-middle') || null, last_name: last || null,
    template_type: type, dob: _v('cf-dob') || null,
    cohort_id: cohortSel && cohortSel !== '__new' ? cohortSel : null, cohort_date: coh?.cohort_date || null,
    preparation_responsible_id: respSel && respSel !== '__other' ? respSel : null,
    preparation_responsible_override: respSel === '__other' ? (_v('cf-resp-other') || null) : null,
    candidate_phone: minor ? null : (_v('cf-cell') || null),
    candidate_email: minor ? (_v('cf-email-minor') || null) : (_v('cf-email') || null),
    school_name: minor ? (_v('cf-school') || null) : null,
    grade_level: minor ? (document.getElementById('cf-grade')?.value || null) : null,
    parent_name: minor ? (_v('cf-parent-name') || null) : null,
    parent_phone: minor ? (_v('cf-parent-phone') || null) : null,
    parent_email: minor ? (_v('cf-parent-email') || null) : null,
    parent_permission_granted: minor ? _chk('cf-parent-perm') : false,
    parent_permission_date: minor ? (_v('cf-parent-permdate') || null) : null,
    confirmation_name: _v('cf-confname') || null,
    sponsor_name: _v('cf-sponsor') || null,
    confirmation_date: _v('cf-confdate') || null,
    confirmation_institution_id: churchSel && churchSel !== '__other' ? churchSel : null,
    confirmation_location: churchSel === '__other' ? (_v('cf-church-override') || null) : (churchSel && churchSel !== '__other' ? ((store.institutions || []).find(i => i.id === churchSel)?.name || null) : null),
    baptism_church: _v('cf-bchurch') || null, baptism_city: _v('cf-bcity') || null, baptism_state: _v('cf-bstate') || null, baptism_country: _v('cf-bcountry') || null,
    first_communion_church: _v('cf-fcchurch') || null, first_communion_city: _v('cf-fccity') || null, first_communion_state: _v('cf-fcstate') || null, first_communion_country: _v('cf-fccountry') || null,
    documents: _M.docs,
    family_group_id: familyGroupId,
    updated_at: nowIso(),
  };

  if (_M.isEdit) {
    const prior = allConf.find(x => x.id === _M.id);
    const newStatus = document.getElementById('cf-status')?.value || statusOf(prior);
    payload.status_code = newStatus;
    payload.archived = _chk('cf-archive');
    if (document.getElementById('cf-svc-done')) { payload.service_hours_completed = parseInt(_v('cf-svc-done')) || 0; payload.service_hours_required = parseInt(document.getElementById('cf-svc-req')?.value) || 0; }
    const tl = JSON.parse(JSON.stringify(prior?.timeline || []));
    if (prior && statusOf(prior) !== 'confirmed' && newStatus === 'confirmed') tl.push({ type: 'auto', text: 'Confirmed', created_at: nowIso() });
    payload.timeline = tl;
    const { error } = await sb.from('sacramental_confirmation').update(payload).eq('id', _M.id);
    if (error) { alert('Save failed: ' + error.message); return; }
    if (linkTarget) await sb.from('sacramental_confirmation').update({ family_group_id: familyGroupId }).eq('id', linkTarget);
    logActivity({ action: 'updated Confirmation record', entityType: 'confirmation', entityName: name, contextType: 'confirmation', contextId: _M.id });
    confCloseModal(); await loadConfirmation();
  } else {
    payload.status_code = 'enrolled';
    payload.archived = false;
    payload.service_hours_required = tmpl.service_hours_enabled ? (tmpl.service_hours_required || 20) : 0;
    payload.service_hours_completed = 0;
    payload.timeline = [{ type: 'auto', text: 'File opened', created_at: nowIso() }];
    const { error } = await sb.from('sacramental_confirmation').insert(payload);
    if (error) { alert('Create failed: ' + error.message); return; }
    if (linkTarget) await sb.from('sacramental_confirmation').update({ family_group_id: familyGroupId }).eq('id', linkTarget);
    logActivity({ action: 'added Confirmation candidate', entityType: 'confirmation', entityName: name, contextType: 'confirmation' });
    const { data: { user } } = await sb.auth.getUser();
    const uids = await getUserIdsForSacrament('confirmation');
    notifyUsers(uids, user?.id, `New Confirmation candidate added: ${name}`, 'info', 'confirmation');
    confCloseModal(); await loadConfirmation();
  }
}
async function confDeletePerson(id) {
  if (!confirm('Permanently delete this record? This cannot be undone.')) return;
  const { error } = await sb.from('sacramental_confirmation').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  confCloseModal(); await loadConfirmation();
}

// ── Cohort manager ───────────────────────────────────────────────────────────
function openCohortManager() { _confOpen(buildCohortHtml()); }
function buildCohortHtml() {
  const counts = {}; allConf.forEach(p => { if (p.cohort_id) counts[p.cohort_id] = (counts[p.cohort_id] || 0) + 1; });
  const list = _cohorts.length ? _cohorts.map(c => `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:.5px solid var(--stone);">
      <div style="flex:1;"><div style="font-size:14px;font-weight:600;color:var(--navy);">${cohortLabel(c.cohort_date)}</div><div style="font-size:12px;color:#6B7280;">${_esc(cohortChurchName(c) || '—')} · ${counts[c.id] || 0} candidate${(counts[c.id] || 0) === 1 ? '' : 's'}</div></div>
      <button onclick="confDeleteCohort('${c.id}')" class="btn-delete" style="padding:.3rem .7rem;font-size:12px;">Delete</button>
    </div>`).join('') : `<div style="font-size:13px;color:#9CA3AF;font-style:italic;padding:.5rem 0;">No cohorts yet.</div>`;
  const instOpts = (store.institutions || []).map(i => `<option value="${i.id}">${_esc(i.name)}</option>`).join('');
  return `<div class="modal-title">Manage Cohorts</div>
    ${list}
    ${_sectionHead('New Cohort')}
    ${_input('coh-date', 'Confirmation Date', '', 'date')}
    <label>Church</label><select id="coh-church" onchange="confCohortChurchChange(this.value)"><option value="">— Select —</option>${instOpts}<option value="__other">Other…</option></select>
    <div id="coh-other-wrap" style="display:none;">${_input('coh-church-name', 'Church name', '')}</div>
    ${_row(_input('coh-city', 'City', ''), _stateSelect('coh-state', ''))}
    <div class="modal-actions"><button class="btn-secondary" onclick="confCloseModal()">Close</button><button class="btn-primary" onclick="confSaveCohort()">+ Add Cohort</button></div>`;
}
function confCohortChurchChange(v) {
  const other = v === '__other';
  document.getElementById('coh-other-wrap').style.display = other ? 'block' : 'none';
  if (!other && v) { const inst = (store.institutions || []).find(i => i.id === v); const cs = parseCityState(inst?.address || ''); const ce = document.getElementById('coh-city'), se = document.getElementById('coh-state'); if (ce && cs.city) ce.value = cs.city; if (se && cs.state) se.value = cs.state; }
}
function parseCityState(addr) { if (!addr) return {}; const parts = addr.split(',').map(s => s.trim()).filter(Boolean); if (parts.length < 2) return {}; const city = parts[parts.length - 2]; const sz = parts[parts.length - 1].split(/\s+/); return { city, state: US_STATES.includes(sz[0]) ? sz[0] : '' }; }
async function confSaveCohort() {
  const date = _v('coh-date'); if (!date) { alert('Confirmation date is required.'); return; }
  const churchSel = document.getElementById('coh-church')?.value || '';
  const payload = { panel: 'confirmation', cohort_date: date, church_institution_id: churchSel && churchSel !== '__other' ? churchSel : null, church_override: churchSel === '__other' ? (_v('coh-church-name') || null) : null, church_city: _v('coh-city') || null, church_state: _v('coh-state') || null };
  const { error } = await sb.from('sacramental_cohorts').insert(payload);
  if (error) { alert('Save failed: ' + error.message); return; }
  await loadCohorts(); _confOpen(buildCohortHtml());
}
async function confDeleteCohort(id) {
  if (!confirm('Delete this cohort? Candidates keep their data but lose the cohort link.')) return;
  const { error } = await sb.from('sacramental_cohorts').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  await loadCohorts(); _confOpen(buildCohortHtml()); renderAll();
}

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
  const btn = document.querySelector('#conf-overlay .modal-actions .btn-primary');
  if (btn) { btn.textContent = 'Saved ✓'; btn.style.background = '#2D6A4F'; setTimeout(() => { btn.textContent = 'Save Template'; btn.style.background = ''; }, 1600); }
}

Object.assign(window, {
  loadConfirmation, expandConfirmation, renderConfList, setConfFilter, confCohortChange, toggleConf,
  openConfCreate, openConfEdit, openConfTemplates, confCloseModal,
  toggleConfDoc, addConfNote,
  confSetType, confRespChange, confCohortPick, confDobChange, confChurchChange,
  confDocReceived, confRemoveDoc, confAddDoc, confFamilySearch, confRemoveFamily,
  confSave, confDeletePerson,
  openCohortManager, confCohortChurchChange, confSaveCohort, confDeleteCohort,
  confTplTab, confTplAdd, confTplRemove, confTplSvcToggle, confTplSave,
});
