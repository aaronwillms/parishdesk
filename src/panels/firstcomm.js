import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, fmtDateYear, todayCST, logActivity } from '../utils.js';
import { isAdmin, canAccessSacrament, isSacramentCoordinator } from '../roles.js';
import { notifyUsers, getUserIdsForSacrament } from '../notifications.js';

const FC_STATUS = {
  enrolled:    { label:'Enrolled',                  color:'#4A1D96', bg:'#EDE9FE', dot:'#7C3AED' },
  preparation: { label:'In Preparation',            color:'#7D6608', bg:'#FEF9E7', dot:'#D4AC0D' },
  complete:    { label:'Preparation Complete',      color:'#2D6A4F', bg:'#D8F3DC', dot:'#2D6A4F' },
  received:    { label:'Received First Communion',  color:'#1B4F72', bg:'#D6EAF8', dot:'#1B4F72' },
  inactive:    { label:'Inactive',                  color:'#616A6B', bg:'#F2F3F4', dot:'#AAB7B8' },
};
const GRADES = ['K', '1', '2', '3', '4', '5', '6', '7', '8', 'Other'];
const COUNTRIES = ['United States of America', 'Mexico', 'Philippines', 'Vietnam', 'Nigeria', 'India', 'Other'];
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];
const CLERGY_TYPES = ['pastor', 'parochial-vicar', 'priest-in-residence', 'deacon', 'religious'];
const CLERGY_TITLE_RE = /^(fr\.|rev\.|deacon|msgr\.|bishop|archbishop|cardinal)/i;
const FALLBACK_DOCS = [{ name: 'Baptismal Certificate', deletable: false }];

let allFc = [], fcFilter = 'all', fcExpanded = null, _cohortFilter = 'all';
let _cohorts = [], _tplDocs = [], _M = null;

function fullAccess() { return isAdmin() || canAccessSacrament('first_communion') || canAccessSacrament('firstcomm'); }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _curUserName() { return store.currentUserProfile?.personnel?.name || 'Staff'; }
function _curUserId() { return store.currentUserProfile?.user_id || null; }
function nowIso() { return new Date().toISOString(); }
function clergyPersonnel() { return (store.personnel || []).filter(p => CLERGY_TYPES.includes(p.type) || (p.title && CLERGY_TITLE_RE.test(p.title))).sort((a, b) => (a.name || '').localeCompare(b.name || '')); }
function ageOf(dob) { if (!dob) return null; const d = new Date(dob); if (isNaN(d)) return null; const now = new Date(new Date().toLocaleString('en-US', { timeZone: store.parishSettings?.timezone || 'America/Chicago' })); let a = now.getFullYear() - d.getFullYear(); const m = now.getMonth() - d.getMonth(); if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--; return a; }
function cohortLabel(dateStr) { if (!dateStr) return 'No date'; const d = new Date(dateStr + 'T00:00:00'); return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); }

// ── Field accessors (backward-compatible) ────────────────────────────────────
function nameOf(p) { return (p.first_name || p.last_name) ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : (p.name || '—'); }
function lastNameOf(p) { if (p.last_name) return p.last_name; const parts = (p.name || '').trim().split(/\s+/); return parts[parts.length - 1] || ''; }
function statusOf(p) { return p.status_code || 'enrolled'; }
function commDate(p) { return p ? (p.communion_date || p.sacrament_date || null) : null; }
function normDocs(p) { return (p.documents || []).map(d => ({ name: d.name, received: d.received ?? d.done ?? false, deletable: d.deletable ?? !d.auto, auto: !!d.auto })); }
function notesOf(p) {
  const out = (Array.isArray(p.notes_log) ? p.notes_log : []).map(n => ({ note: n.note || '', by: n.by || null, created_at: n.created_at || null }));
  if (p.notes && String(p.notes).trim()) out.push({ note: String(p.notes).trim(), by: null, created_at: null, legacy: true });
  return out;
}

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadTemplate() { const { data } = await sb.from('firstcomm_templates').select('documents').limit(1); _tplDocs = (data && data[0]?.documents) || JSON.parse(JSON.stringify(FALLBACK_DOCS)); }
async function loadCohorts() { const { data } = await sb.from('sacramental_cohorts').select('*').eq('panel', 'firstcomm').order('cohort_date', { ascending: false }); _cohorts = data || []; }
export async function loadFirstComm() {
  await Promise.all([loadTemplate(), loadCohorts()]);
  const { data, error } = await sb.from('sacramental_firstcomm').select('*').order('created_at', { ascending: false });
  if (error) { console.error('[firstcomm]', error); return; }
  allFc = data || [];
  store.allFirstComm = allFc;
  renderAll(); updateStats();
}
function updateStats() {
  const active = allFc.filter(p => !p.archived && statusOf(p) !== 'inactive');
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('stat-fc-total', active.length);
  set('stat-fc-upcoming', active.filter(p => commDate(p) && commDate(p) >= todayCST() && statusOf(p) !== 'received').length);
  set('stat-fc-docs', active.filter(p => normDocs(p).some(d => !d.received) || !p.preparation_complete).length);
}

// ── Chrome ───────────────────────────────────────────────────────────────────
function renderAll() {
  const root = document.getElementById('firstcomm-root'); if (!root) return;
  const manage = fullAccess();
  const filters = [['all', 'All'], ['enrolled', 'Enrolled'], ['preparation', 'In Preparation'], ['complete', 'Preparation Complete'], ['received', 'Received First Communion'], ['inactive', 'Inactive']]
    .map(([k, l]) => `<button class="cf-btn${fcFilter === k ? ' active' : ''}" onclick="setFcFilter('${k}',this)">${l}</button>`).join('');
  const cohortOpts = `<option value="all"${_cohortFilter === 'all' ? ' selected' : ''}>All Cohorts</option>`
    + _cohorts.map(c => `<option value="${c.id}"${_cohortFilter === c.id ? ' selected' : ''}>${cohortLabel(c.cohort_date)}</option>`).join('')
    + `<option value="__manage">⚙ Manage Cohorts…</option>`;
  root.innerHTML = `
    <div class="card" style="padding:.875rem 1.25rem;">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <input type="text" id="fc-search" placeholder="Search by name…" oninput="renderFcList()" style="flex:1;min-width:140px;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .75rem;font-size:13px;font-family:'Inter',sans-serif;background:#FFFFFF;outline:none;" />
        <select id="fc-cohort" onchange="fcCohortChange(this.value)" style="border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;">${cohortOpts}</select>
        ${(isSacramentCoordinator('first_communion') || isSacramentCoordinator('firstcomm')) ? `<button class="anl-icon-btn" title="Document templates" onclick="openFcTemplate()"><i class="fa-solid fa-gear"></i></button>` : ''}
        ${manage ? `<button class="btn-primary" style="white-space:nowrap;" onclick="openFcCreate()">+ Add Student</button>` : ''}
      </div>
      <div style="display:flex;gap:6px;margin-top:.75rem;flex-wrap:wrap;">${filters}</div>
    </div>
    <div id="fc-list"></div>`;
  renderFcList();
}
function setFcFilter(f, el) { fcFilter = f; document.querySelectorAll('#panel-firstcomm .cf-btn').forEach(b => b.classList.remove('active')); el?.classList.add('active'); renderFcList(); }
function fcCohortChange(v) { if (v === '__manage') { document.getElementById('fc-cohort').value = _cohortFilter; openCohortManager(); return; } _cohortFilter = v; renderFcList(); }

function renderFcList() {
  const el = document.getElementById('fc-list'); if (!el) return;
  const q = (document.getElementById('fc-search')?.value || '').toLowerCase();
  const items = allFc.filter(p => {
    if (fcFilter !== 'all' && statusOf(p) !== fcFilter) return false;
    if (_cohortFilter !== 'all' && (p.cohort_id || '') !== _cohortFilter) return false;
    return !q || nameOf(p).toLowerCase().includes(q);
  });
  if (!items.length) { el.innerHTML = '<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No students match.</div>'; return; }
  const active = items.filter(p => !p.archived), archived = items.filter(p => p.archived);
  const renderCohortGroups = (list) => {
    const byCohort = {}; list.forEach(p => { const k = p.cohort_id || '__none'; (byCohort[k] = byCohort[k] || []).push(p); });
    const keys = Object.keys(byCohort).sort((a, b) => {
      if (a === '__none') return 1; if (b === '__none') return -1;
      const ca = _cohorts.find(c => c.id === a), cb = _cohorts.find(c => c.id === b);
      return (cb?.cohort_date || '').localeCompare(ca?.cohort_date || '');
    });
    return keys.map(k => {
      const coh = _cohorts.find(c => c.id === k);
      const header = k === '__none' ? 'No Cohort' : cohortLabel(coh?.cohort_date) + (cohortChurchName(coh) ? ` · ${_esc(cohortChurchName(coh))}` : '');
      return `<div style="display:flex;align-items:center;gap:10px;margin:16px 0 8px;"><span style="font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#7D6608;">🍞 ${_esc(header)}</span><div style="flex:1;height:.5px;background:var(--stone);"></div></div>`
        + familyOrder(byCohort[k]).map(renderFcCard).join('');
    }).join('');
  };
  let html = renderCohortGroups(active);
  if (archived.length) {
    html += `<div style="display:flex;align-items:center;gap:10px;margin:18px 0 10px;"><div style="flex:1;height:.5px;background:var(--stone);"></div><span style="font-size:11px;color:#6B7280;letter-spacing:.07em;text-transform:uppercase;font-weight:500;">Archived</span><div style="flex:1;height:.5px;background:var(--stone);"></div></div>`;
    html += familyOrder(archived).map(renderFcCard).join('');
  }
  el.innerHTML = html;
}
function cohortChurchName(coh) { if (!coh) return ''; if (coh.church_institution_id) { const i = (store.institutions || []).find(x => x.id === coh.church_institution_id); if (i) return i.name; } return coh.church_override || ''; }
function familyOrder(list) {
  const groups = {}; list.forEach(p => { if (p.family_group_id) (groups[p.family_group_id] = groups[p.family_group_id] || []).push(p); });
  const seen = new Set(); const out = [];
  list.forEach(p => {
    if (p.family_group_id) { if (seen.has(p.family_group_id)) return; seen.add(p.family_group_id); out.push(...groups[p.family_group_id].slice().sort((a, b) => (ageOf(b.dob) ?? -1) - (ageOf(a.dob) ?? -1))); }
    else out.push(p);
  });
  return out;
}

// ── Card ─────────────────────────────────────────────────────────────────────
function renderFcCard(p) {
  const sm = FC_STATUS[statusOf(p)] || FC_STATUS.enrolled;
  const age = ageOf(p.dob);
  const exp = fcExpanded === p.id;
  const fam = p.family_group_id ? `${lastNameOf(p)} Family` : null;
  const cd = commDate(p);
  const ageNotice = age !== null && age > 13;
  const docs = normDocs(p); const done = docs.filter(d => d.received).length;
  const progress = docs.length ? Math.round((done / docs.length) * 100) : null;

  let h = `<div class="couple-card${ageNotice ? ' urgent' : ''}" id="fc-card-${p.id}" style="border-left:4px solid ${sm.dot};">
    <div class="couple-header" onclick="toggleFc('${p.id}')">
      <div style="flex:1;min-width:0;">
        <span class="couple-name">${_esc(nameOf(p))}${age !== null ? ` <span style="font-size:12px;color:#6B7280;font-weight:400;">(${age})</span>` : ''}</span>
        <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap;align-items:center;">
          <span style="background:${sm.bg};color:${sm.color};border-radius:20px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:.04em;display:inline-flex;align-items:center;gap:5px;border:1px solid ${sm.color}33;"><span style="width:7px;height:7px;border-radius:50%;background:${sm.dot};display:inline-block;"></span>${sm.label}</span>
          ${cd ? `<span style="font-size:11px;background:#FEF9E7;color:#7D6608;border-radius:20px;padding:2px 8px;">🍞 ${cohortLabel(cd)}</span>` : ''}
          ${fam ? `<span style="font-size:11px;color:#5B4636;background:#F3ECE0;border-radius:20px;padding:2px 8px;">👪 ${_esc(fam)}</span>` : ''}
          ${progress !== null ? (progress === 100 ? `<span style="font-size:11px;color:#2D6A4F;">✅ docs complete</span>` : `<span style="font-size:11px;color:#922B21;">${done}/${docs.length} docs</span>`) : ''}
        </div>
        ${ageNotice ? `<div style="margin-top:5px;background:#FEF9E7;border-left:3px solid #D4AC0D;border-radius:3px;padding:4px 10px;font-size:12px;font-weight:600;color:#7D6608;">⚠ Consider the Confirmation or OCIA panel for older candidates</div>` : ''}
      </div>
      <span style="font-size:16px;color:#B0A090;">${exp ? '▲' : '▼'}</span>
    </div>`;
  if (exp) h += renderFcBody(p, docs, progress, done);
  h += `</div>`;
  return h;
}

function renderFcBody(p, docs, progress, done) {
  let h = `<div class="couple-body">`;
  h += `<div style="margin-top:10px;">`;
  if (p.dob) h += `<span class="detail-chip">🎂 ${_esc(p.dob)}</span>`;
  const grade = p.grade_level || p.grade;
  if (grade) h += `<span class="detail-chip">Grade ${_esc(grade)}</span>`;
  if (p.school_name) h += `<span class="detail-chip">🏫 ${_esc(p.school_name)}</span>`;
  h += `</div>`;
  const phone = p.parent1_phone || p.phone, email = p.parent1_email || p.email;
  if (phone || email) { h += `<div style="margin-top:8px;">`; if (phone) h += `<a href="tel:${phone}" class="contact-chip">📞 ${_esc(phone)}</a>`; if (email) h += `<a href="mailto:${email}" class="contact-chip">✉️ ${_esc(email)}</a>`; h += `</div>`; }
  const par1 = (p.parent1_first || p.parent1_last) ? `${p.parent1_first || ''} ${p.parent1_last || ''}`.trim() : (p.parent1 || p.parent2);
  if (par1) {
    h += `<div class="couple-section-label">Parent / Guardian</div>`;
    h += `<div style="font-size:13px;">${_esc(par1)}${p.parent1_phone ? ' · ' + _esc(p.parent1_phone) : ''}</div>`;
  }
  if (commDate(p) || p.communion_church_override || p.communion_institution_id) {
    const ch = p.communion_institution_id ? ((store.institutions || []).find(x => x.id === p.communion_institution_id)?.name) : p.communion_church_override;
    h += `<div style="font-size:13px;margin-top:6px;">First Communion: <strong>${commDate(p) ? fmtDateYear(commDate(p)) : ''}</strong>${ch ? ' · ' + _esc(ch) : ''}</div>`;
  }
  // documents
  if (docs.length) {
    h += `<div class="couple-section-label" style="margin-top:12px;">Document checklist</div>`;
    if (progress !== null) h += `<div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${progress}%;background:${progress === 100 ? '#2D6A4F' : 'var(--gold)'};"></div></div><div style="font-size:11px;color:#888;margin-bottom:6px;">${done}/${docs.length} received</div>`;
    h += docs.map((d, i) => `<div class="doc-item" style="padding:4px 6px;display:flex;align-items:center;gap:8px;">
      <span style="font-size:15px;cursor:pointer;" onclick="toggleFcDoc('${p.id}',${i})">${d.received ? '✅' : '⬜'}</span>
      <span style="flex:1;color:${d.received ? '#2D6A4F' : 'var(--navy)'};cursor:pointer;" onclick="toggleFcDoc('${p.id}',${i})">${_esc(d.name)}</span>
      ${!d.deletable ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required"></i>` : ''}
    </div>`).join('');
  }
  // single prep step
  h += `<div class="couple-section-label" style="margin-top:12px;">Preparation</div>
    <div class="doc-item" style="padding:4px 6px;display:flex;align-items:center;gap:8px;">
      <span style="font-size:15px;cursor:pointer;" onclick="toggleFcPrep('${p.id}')">${p.preparation_complete ? '✅' : '⬜'}</span>
      <span style="flex:1;color:${p.preparation_complete ? '#2D6A4F' : 'var(--navy)'};cursor:pointer;" onclick="toggleFcPrep('${p.id}')">Parent/Guardian Preparation Complete</span>
      ${p.preparation_complete && p.preparation_complete_date ? `<span style="font-size:11px;color:#9CA3AF;">${fmtDate(String(p.preparation_complete_date).slice(0, 10))}</span>` : ''}
    </div>`;
  // notes
  const notes = notesOf(p);
  h += `<div class="couple-section-label" style="margin-top:12px;">Notes</div>
    <div style="display:flex;gap:6px;margin-bottom:8px;"><input type="text" id="fcn-${p.id}" placeholder="Add a note…" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();addFcNote('${p.id}');}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="addFcNote('${p.id}')">Add</button></div>`;
  h += notes.length ? notes.map(n => `<div style="font-size:13px;color:#555;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;"><div style="white-space:pre-wrap;">${_esc(n.note)}</div>${(n.by || n.created_at) ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${n.created_at ? fmtDate(String(n.created_at).slice(0, 10)) : ''}${n.by ? ' · ' + _esc(n.by) : ''}</div>` : ''}</div>`).join('') : `<div style="font-size:13px;color:#9CA3AF;font-style:italic;padding:.25rem 0;">No notes yet.</div>`;
  h += `<div style="margin-top:12px;text-align:right;"><button class="anl-icon-btn" title="Edit" onclick="openFcEdit('${p.id}')"><i class="fa-solid fa-pencil"></i></button></div></div>`;
  return h;
}

function toggleFc(id) { fcExpanded = fcExpanded === id ? null : id; renderFcList(); }
export async function expandFirstComm(id) { fcExpanded = id; window.switchPanel('firstcomm'); await loadFirstComm(); document.getElementById('fc-card-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }

// ── Autosave ─────────────────────────────────────────────────────────────────
async function _patch(id, patch) { const p = allFc.find(x => x.id === id); if (!p) return null; const { error } = await sb.from('sacramental_firstcomm').update({ ...patch, updated_at: nowIso() }).eq('id', id); if (error) { alert('Save failed: ' + error.message); return null; } Object.assign(p, patch); return p; }
async function toggleFcDoc(id, i) {
  const p = allFc.find(x => x.id === id); if (!p) return;
  const docs = normDocs(p); docs[i].received = !docs[i].received;
  const prevAll = normDocs(p).length > 0 && normDocs(p).every(d => d.received);
  const allDone = docs.length > 0 && docs.every(d => d.received);
  const patch = { documents: docs };
  if (allDone && !prevAll) { const tl = JSON.parse(JSON.stringify(p.timeline || [])); tl.push({ type: 'auto', text: 'All documents received', created_at: nowIso() }); patch.timeline = tl; }
  if (await _patch(id, patch)) { renderFcList(); updateStats(); }
}
async function toggleFcPrep(id) {
  const p = allFc.find(x => x.id === id); if (!p) return;
  const done = !p.preparation_complete;
  if (await _patch(id, { preparation_complete: done, preparation_complete_date: done ? todayCST() : null, preparation_complete_by: done ? _curUserId() : null })) { renderFcList(); updateStats(); }
}
async function addFcNote(id) {
  const inp = document.getElementById('fcn-' + id); const note = (inp?.value || '').trim(); if (!note) return;
  const p = allFc.find(x => x.id === id); if (!p) return;
  const log = Array.isArray(p.notes_log) ? JSON.parse(JSON.stringify(p.notes_log)) : [];
  log.push({ note, by: _curUserName(), created_at: nowIso() });
  if (await _patch(id, { notes_log: log })) renderFcList();
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

async function openFcCreate() {
  let coordId = null;
  try { const { data } = await sb.from('program_coordinators').select('coordinator_ids').eq('program', 'firstcomm').maybeSingle(); coordId = data?.coordinator_ids?.[0] || null; } catch (_) {}
  _M = newModalState(null, coordId);
  _fcOpen(buildModalHtml(null)); _hydrate();
}
function openFcEdit(id) { const p = allFc.find(x => x.id === id); if (!p) return; _M = newModalState(p, p.preparation_responsible_id || null); _fcOpen(buildModalHtml(p)); _hydrate(); }
function newModalState(p, coordId) {
  return {
    id: p?.id || null, isEdit: !!p,
    respId: p?.preparation_responsible_id || coordId || '', respOther: !p?.preparation_responsible_id && !!p?.preparation_responsible_override,
    docs: p ? normDocs(p) : computeTemplateDocs(),
    family: p?.family_group_id ? { group_id: p.family_group_id, label: `${lastNameOf(p)} Family` } : null,
  };
}
function computeTemplateDocs() {
  const base = (_tplDocs || FALLBACK_DOCS).map(d => ({ name: d.name, received: false, deletable: d.deletable ?? true, auto: d.deletable === false }));
  if (!base.some(d => /baptismal certificate/i.test(d.name))) base.unshift({ name: 'Baptismal Certificate', received: false, deletable: false, auto: true });
  return base;
}
function _nameParts(p) { return { first: p?.first_name || (p?.name || '').split(/\s+/)[0] || '', middle: p?.middle_name || '', last: p?.last_name || (p?.name || '').split(/\s+/).slice(1).join(' ') || '' }; }

function buildModalHtml(p) {
  const isEdit = _M.isEdit;
  const np = _nameParts(p);
  const age = ageOf(p?.dob);
  const respOpts = clergyPersonnel().map(c => `<option value="${c.id}"${_M.respId === c.id ? ' selected' : ''}>${_esc(c.name)}</option>`).join('');
  const instOpts = (store.institutions || []).map(i => `<option value="${i.id}"${p?.communion_institution_id === i.id ? ' selected' : ''}>${_esc(i.name)}</option>`).join('');
  const cohortOpts = _cohorts.map(c => `<option value="${c.id}"${p?.cohort_id === c.id ? ' selected' : ''}>${cohortLabel(c.cohort_date)}</option>`).join('');

  let h = `<div class="modal-title">${isEdit ? 'Edit First Communion File' : 'New First Communion Student'}</div>`;

  // 1 — Person responsible
  h += _sectionHead('Person Responsible');
  h += `<label>Person Responsible</label><select id="ff-resp" onchange="fcRespChange(this.value)"><option value="">— Select —</option>${respOpts}<option value="__other"${_M.respOther ? ' selected' : ''}>Other…</option></select>
    <div id="ff-resp-other-wrap" style="display:${_M.respOther ? 'block' : 'none'};">${_input('ff-resp-other', 'Name', p?.preparation_responsible_override || '')}</div>`;

  // 2 — Cohort
  h += _sectionHead('Cohort');
  h += `<label>Cohort</label><select id="ff-cohort" onchange="fcCohortPick(this.value)"><option value="">— None —</option>${cohortOpts}<option value="__new">+ Create new cohort…</option></select>`;

  // 3 — Child info
  h += _sectionHead('Child Information');
  h += _row(_input('ff-first', 'First Name', np.first), _input('ff-middle', 'Middle', np.middle), _input('ff-last', 'Last Name', np.last));
  h += `<label>Date of Birth</label><input type="${(p?.dob && /^\d{4}-\d{2}-\d{2}/.test(p.dob)) ? 'date' : 'text'}" id="ff-dob" value="${_esc(p?.dob || '')}" placeholder="YYYY-MM-DD" oninput="fcDobChange()" />`;
  h += `<div id="ff-age-note" class="anl-info-box" style="display:${age !== null && age > 13 ? 'block' : 'none'};">For older candidates, consider the Confirmation or OCIA panel.</div>`;
  h += _row(_input('ff-school', 'School Name', p?.school_name || ''), `<label>Grade Level</label><select id="ff-grade">${GRADES.map(g => `<option${(p?.grade_level || p?.grade) === g ? ' selected' : ''}>${g}</option>`).join('')}</select>`);
  h += _input('ff-street', 'Mailing Street Address', p?.child_street || '');
  h += _row(_input('ff-city', 'City', p?.child_city || ''), _stateSelect('ff-state', p?.child_state || ''), _input('ff-zip', 'ZIP', p?.child_zip || ''));

  // 4 — Parents
  h += _sectionHead('Parent / Guardian');
  h += _row(_input('ff-p1first', 'First Name', p?.parent1_first || ''), _input('ff-p1last', 'Last Name', p?.parent1_last || ''));
  h += _row(_input('ff-p1phone', 'Cell Phone', p?.parent1_phone || p?.phone || ''), _input('ff-p1email', 'Email', p?.parent1_email || p?.email || ''));

  // 5 — Baptism
  h += _sectionHead('Baptism Information');
  h += _input('ff-bchurch', 'Church of Baptism', p?.baptism_church || '');
  h += _row(_input('ff-bcity', 'City', p?.baptism_city || ''), _stateSelect('ff-bstate', p?.baptism_state || ''));
  h += `<label>Country</label><select id="ff-bcountry">${COUNTRIES.map(co => `<option${(p?.baptism_country || 'United States of America') === co ? ' selected' : ''}>${co}</option>`).join('')}</select>`;

  // 6 — First communion details
  h += _sectionHead('First Communion Details');
  h += _input('ff-cdate', 'First Communion Date', commDate(p) || '', 'date');
  h += `<label>Church</label><select id="ff-church" onchange="fcChurchChange(this.value)"><option value="">— Select —</option>${instOpts}<option value="__other"${(p?.communion_church_override && !p?.communion_institution_id) ? ' selected' : ''}>Other…</option></select>
    <div id="ff-church-other-wrap" style="display:${(p?.communion_church_override && !p?.communion_institution_id) ? 'block' : 'none'};">${_input('ff-church-override', 'Church name', p?.communion_church_override || '')}</div>
    ${_row(_input('ff-ccity', 'City', p?.communion_city || ''), _stateSelect('ff-cstate', p?.communion_state || ''))}`;

  // 7 — Documents
  h += _sectionHead('Document Checklist');
  h += `<div id="ff-docs"></div><div style="display:flex;gap:6px;margin-top:6px;"><input type="text" id="ff-doc-new" placeholder="Add document…" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();fcAddDoc();}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="fcAddDoc()">+ Add</button></div>`;

  // 8 — Family group (create + edit)
  h += _sectionHead('Family Group');
  h += `<div style="position:relative;"><input type="text" id="ff-family-search" placeholder="Link to family group (search by last name)…" autocomplete="off" oninput="fcFamilySearch()" style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" /><div id="ff-family-results" class="anl-link-results" style="display:none;"></div></div><div id="ff-family-chip" style="margin-top:6px;"></div>`;

  if (isEdit) {
    h += _sectionHead('Status');
    h += `<label>Status</label><select id="ff-status">${Object.entries(FC_STATUS).map(([k, v]) => `<option value="${k}"${statusOf(p) === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`;
    h += _toggle('ff-archive', 'Archive this file', !!p?.archived);
  }

  h += `<div class="modal-actions" style="justify-content:space-between;">
    ${isEdit ? `<button class="btn-delete" onclick="fcDeletePerson('${_M.id}')">Delete</button>` : '<span></span>'}
    <div style="display:flex;gap:8px;"><button class="btn-secondary" onclick="fcCloseModal()">Cancel</button><button class="btn-primary" onclick="fcSave()">${isEdit ? 'Save' : 'Create File'}</button></div>
  </div>`;
  return h;
}

function _hydrate() { renderModalDocs(); renderFamilyChip(); }
function renderModalDocs() {
  const el = document.getElementById('ff-docs'); if (!el) return;
  el.innerHTML = _M.docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
    <input type="checkbox" ${d.received ? 'checked' : ''} onchange="fcDocReceived(${i},this.checked)" style="width:15px;height:15px;accent-color:var(--cardinal);" />
    <span style="flex:1;font-size:13px;color:var(--navy);">${_esc(d.name)}</span>
    ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required"></i>` : `<button onclick="fcRemoveDoc(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>`}
  </div>`).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No documents.</div>`;
}
function renderFamilyChip() { const el = document.getElementById('ff-family-chip'); if (!el) return; el.innerHTML = _M.family ? `<span style="display:inline-flex;align-items:center;gap:8px;background:#1C2B3A;color:#fff;border-radius:14px;padding:3px 8px 3px 12px;font-size:12px;"><span>${_esc(_M.family.label)}</span><button onclick="fcRemoveFamily()" style="background:none;border:none;color:#cdd6df;cursor:pointer;font-size:12px;padding:0;">×</button></span>` : ''; }

function fcRespChange(v) { _M.respOther = v === '__other'; document.getElementById('ff-resp-other-wrap').style.display = _M.respOther ? 'block' : 'none'; }
function fcCohortPick(v) { if (v === '__new') { document.getElementById('ff-cohort').value = ''; openCohortManager(); return; } const coh = _cohorts.find(c => c.id === v); if (coh?.cohort_date) { const dt = document.getElementById('ff-cdate'); if (dt && !dt.value) dt.value = coh.cohort_date; } }
function fcDobChange() { const age = ageOf(document.getElementById('ff-dob').value); document.getElementById('ff-age-note').style.display = (age !== null && age > 13) ? 'block' : 'none'; }
function fcChurchChange(v) { document.getElementById('ff-church-other-wrap').style.display = v === '__other' ? 'block' : 'none'; }
function fcDocReceived(i, v) { _M.docs[i].received = v; }
function fcRemoveDoc(i) { _M.docs.splice(i, 1); renderModalDocs(); }
function fcAddDoc() { const inp = document.getElementById('ff-doc-new'); const name = (inp?.value || '').trim(); if (!name) return; _M.docs.push({ name, received: false, deletable: true, auto: false }); inp.value = ''; renderModalDocs(); }
async function fcFamilySearch() {
  const q = document.getElementById('ff-family-search')?.value || ''; const box = document.getElementById('ff-family-results'); if (!box) return;
  if (q.trim().length < 2) { box.style.display = 'none'; return; }
  const safe = q.replace(/[%_,()'"*]/g, ' ');
  const { data } = await sb.from('sacramental_firstcomm').select('id,name,first_name,last_name,family_group_id').or(`name.ilike.%${safe}%,last_name.ilike.%${safe}%,first_name.ilike.%${safe}%`).limit(6);
  const rows = (data || []);
  box.innerHTML = rows.length ? rows.map(r => `<div class="anl-link-opt" data-id="${r.id}" data-gid="${r.family_group_id || ''}" data-last="${_esc(lastNameOf(r))}">${_esc(nameOf(r))} — ${_esc(lastNameOf(r))} Family</div>`).join('') : `<div style="padding:.5rem .7rem;font-size:12px;color:#9CA3AF;">No matches</div>`;
  box.style.display = 'block';
  box.querySelectorAll('.anl-link-opt').forEach(o => o.addEventListener('mousedown', e => { e.preventDefault(); _M.family = { target_id: o.dataset.id, group_id: o.dataset.gid || null, label: `${o.dataset.last} Family` }; box.style.display = 'none'; document.getElementById('ff-family-search').value = ''; renderFamilyChip(); }));
}
function fcRemoveFamily() { _M.family = null; renderFamilyChip(); }

// ── Save ─────────────────────────────────────────────────────────────────────
function _v(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function _chk(id) { return !!document.getElementById(id)?.checked; }
async function fcSave() {
  const first = _v('ff-first'), last = _v('ff-last');
  const name = [first, _v('ff-middle'), last].filter(Boolean).join(' ');
  if (!name) { alert('Student name is required.'); return; }
  const respSel = document.getElementById('ff-resp')?.value || '';
  const cohortSel = document.getElementById('ff-cohort')?.value || '';
  const coh = _cohorts.find(c => c.id === cohortSel);
  const churchSel = document.getElementById('ff-church')?.value || '';

  let familyGroupId = null, linkTarget = null;
  if (_M.family) { if (_M.family.group_id) familyGroupId = _M.family.group_id; else { familyGroupId = (crypto?.randomUUID?.() || String(Date.now())); linkTarget = _M.family.target_id; } }

  const payload = {
    name, first_name: first || null, middle_name: _v('ff-middle') || null, last_name: last || null,
    dob: _v('ff-dob') || null,
    cohort_id: cohortSel && cohortSel !== '__new' ? cohortSel : null, cohort_date: coh?.cohort_date || null,
    preparation_responsible_id: respSel && respSel !== '__other' ? respSel : null,
    preparation_responsible_override: respSel === '__other' ? (_v('ff-resp-other') || null) : null,
    school_name: _v('ff-school') || null, grade_level: document.getElementById('ff-grade')?.value || null,
    child_street: _v('ff-street') || null, child_city: _v('ff-city') || null, child_state: _v('ff-state') || null, child_zip: _v('ff-zip') || null,
    parent1_first: _v('ff-p1first') || null, parent1_last: _v('ff-p1last') || null, parent1_phone: _v('ff-p1phone') || null, parent1_email: _v('ff-p1email') || null,
    baptism_church: _v('ff-bchurch') || null, baptism_city: _v('ff-bcity') || null, baptism_state: _v('ff-bstate') || null, baptism_country: _v('ff-bcountry') || null,
    communion_date: _v('ff-cdate') || null,
    communion_institution_id: churchSel && churchSel !== '__other' ? churchSel : null,
    communion_church_override: churchSel === '__other' ? (_v('ff-church-override') || null) : null,
    communion_city: _v('ff-ccity') || null, communion_state: _v('ff-cstate') || null,
    documents: _M.docs,
    family_group_id: familyGroupId,
    updated_at: nowIso(),
  };

  if (_M.isEdit) {
    const prior = allFc.find(x => x.id === _M.id);
    const newStatus = document.getElementById('ff-status')?.value || statusOf(prior);
    payload.status_code = newStatus;
    payload.archived = _chk('ff-archive');
    const tl = JSON.parse(JSON.stringify(prior?.timeline || []));
    if (prior && statusOf(prior) !== 'received' && newStatus === 'received') tl.push({ type: 'auto', text: 'First Communion Received', created_at: nowIso() });
    payload.timeline = tl;
    const { error } = await sb.from('sacramental_firstcomm').update(payload).eq('id', _M.id);
    if (error) { alert('Save failed: ' + error.message); return; }
    if (linkTarget) await sb.from('sacramental_firstcomm').update({ family_group_id: familyGroupId }).eq('id', linkTarget);
    logActivity({ action: 'updated First Communion record', entityType: 'firstcomm', entityName: name, contextType: 'firstcomm', contextId: _M.id });
    fcCloseModal(); await loadFirstComm();
  } else {
    payload.status_code = 'enrolled';
    payload.archived = false;
    payload.timeline = [{ type: 'auto', text: 'File opened', created_at: nowIso() }];
    const { error } = await sb.from('sacramental_firstcomm').insert(payload);
    if (error) { alert('Create failed: ' + error.message); return; }
    if (linkTarget) await sb.from('sacramental_firstcomm').update({ family_group_id: familyGroupId }).eq('id', linkTarget);
    logActivity({ action: 'added First Communion student', entityType: 'firstcomm', entityName: name, contextType: 'firstcomm' });
    const { data: { user } } = await sb.auth.getUser();
    const uids = await getUserIdsForSacrament('first_communion');
    notifyUsers(uids, user?.id, `New First Communion student added: ${name}`, 'info', 'firstcomm');
    fcCloseModal(); await loadFirstComm();
  }
}
async function fcDeletePerson(id) {
  if (!confirm('Permanently delete this record? This cannot be undone.')) return;
  const { error } = await sb.from('sacramental_firstcomm').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  fcCloseModal(); await loadFirstComm();
}

// ── Cohort manager (panel = 'firstcomm') ─────────────────────────────────────
function openCohortManager() { _fcOpen(buildCohortHtml()); }
function buildCohortHtml() {
  const counts = {}; allFc.forEach(p => { if (p.cohort_id) counts[p.cohort_id] = (counts[p.cohort_id] || 0) + 1; });
  const list = _cohorts.length ? _cohorts.map(c => `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:.5px solid var(--stone);">
      <div style="flex:1;"><div style="font-size:14px;font-weight:600;color:var(--navy);">${cohortLabel(c.cohort_date)}</div><div style="font-size:12px;color:#6B7280;">${_esc(cohortChurchName(c) || '—')} · ${counts[c.id] || 0} student${(counts[c.id] || 0) === 1 ? '' : 's'}</div></div>
      <button onclick="fcDeleteCohort('${c.id}')" class="btn-delete" style="padding:.3rem .7rem;font-size:12px;">Delete</button>
    </div>`).join('') : `<div style="font-size:13px;color:#9CA3AF;font-style:italic;padding:.5rem 0;">No cohorts yet.</div>`;
  const instOpts = (store.institutions || []).map(i => `<option value="${i.id}">${_esc(i.name)}</option>`).join('');
  return `<div class="modal-title">Manage Cohorts</div>
    ${list}
    ${_sectionHead('New Cohort')}
    ${_input('fcoh-date', 'First Communion Date', '', 'date')}
    <label>Church</label><select id="fcoh-church" onchange="fcCohortChurchChange(this.value)"><option value="">— Select —</option>${instOpts}<option value="__other">Other…</option></select>
    <div id="fcoh-other-wrap" style="display:none;">${_input('fcoh-church-name', 'Church name', '')}</div>
    ${_row(_input('fcoh-city', 'City', ''), _stateSelect('fcoh-state', ''))}
    <div class="modal-actions"><button class="btn-secondary" onclick="fcCloseModal()">Close</button><button class="btn-primary" onclick="fcSaveCohort()">+ Add Cohort</button></div>`;
}
function fcCohortChurchChange(v) { const other = v === '__other'; document.getElementById('fcoh-other-wrap').style.display = other ? 'block' : 'none'; if (!other && v) { const inst = (store.institutions || []).find(i => i.id === v); const cs = parseCityState(inst?.address || ''); const ce = document.getElementById('fcoh-city'), se = document.getElementById('fcoh-state'); if (ce && cs.city) ce.value = cs.city; if (se && cs.state) se.value = cs.state; } }
function parseCityState(addr) { if (!addr) return {}; const parts = addr.split(',').map(s => s.trim()).filter(Boolean); if (parts.length < 2) return {}; const city = parts[parts.length - 2]; const sz = parts[parts.length - 1].split(/\s+/); return { city, state: US_STATES.includes(sz[0]) ? sz[0] : '' }; }
async function fcSaveCohort() {
  const date = _v('fcoh-date'); if (!date) { alert('First Communion date is required.'); return; }
  const churchSel = document.getElementById('fcoh-church')?.value || '';
  const payload = { panel: 'firstcomm', cohort_date: date, church_institution_id: churchSel && churchSel !== '__other' ? churchSel : null, church_override: churchSel === '__other' ? (_v('fcoh-church-name') || null) : null, church_city: _v('fcoh-city') || null, church_state: _v('fcoh-state') || null };
  const { error } = await sb.from('sacramental_cohorts').insert(payload);
  if (error) { alert('Save failed: ' + error.message); return; }
  await loadCohorts(); _fcOpen(buildCohortHtml());
}
async function fcDeleteCohort(id) {
  if (!confirm('Delete this cohort? Students keep their data but lose the cohort link.')) return;
  const { error } = await sb.from('sacramental_cohorts').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  await loadCohorts(); _fcOpen(buildCohortHtml()); renderAll();
}

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
  const btn = document.querySelector('#fc-overlay .modal-actions .btn-primary');
  if (btn) { btn.textContent = 'Saved ✓'; btn.style.background = '#2D6A4F'; setTimeout(() => { btn.textContent = 'Save Template'; btn.style.background = ''; }, 1600); }
}

Object.assign(window, {
  loadFirstComm, expandFirstComm, renderFcList, setFcFilter, fcCohortChange, toggleFc,
  openFcCreate, openFcEdit, openFcTemplate, fcCloseModal,
  toggleFcDoc, toggleFcPrep, addFcNote,
  fcRespChange, fcCohortPick, fcDobChange, fcChurchChange,
  fcDocReceived, fcRemoveDoc, fcAddDoc, fcFamilySearch, fcRemoveFamily,
  fcSave, fcDeletePerson,
  openCohortManager, fcCohortChurchChange, fcSaveCohort, fcDeleteCohort,
  fcTplAdd, fcTplRemove, fcTplSave,
});
