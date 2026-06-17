import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, fmtDateYear, todayCST, logActivity } from '../utils.js';
import { expandCase } from './annulments.js';
import { isAdmin, canAccessSacrament, isSacramentCoordinator } from '../roles.js';
import { notifyUsers, getUserIdsForSacrament } from '../notifications.js';

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
const CLERGY_TITLE_RE = /^(fr\.|rev\.|deacon|msgr\.|bishop|archbishop|cardinal)/i;
const FALLBACK_TEMPLATES = { catechumen: [], candidate: [{ name: 'Baptismal Certificate', deletable: false }] };

let allOcia = [], ociaFilter = 'all', ociaExpanded = null;
let _templates = {}, _M = null;

function fullAccess() { return isAdmin() || canAccessSacrament('ocia'); }
function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function _curUserName() { return store.currentUserProfile?.personnel?.name || 'Staff'; }
function nowIso() { return new Date().toISOString(); }
function clergyPersonnel() { return (store.personnel || []).filter(p => CLERGY_TYPES.includes(p.type) || (p.title && CLERGY_TITLE_RE.test(p.title))).sort((a, b) => (a.name || '').localeCompare(b.name || '')); }

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
function caseIsConfirmed(caseId) { if (!caseId) return false; const c = (store.allCases || []).find(x => x.id === caseId); return !!(c && c.status_code === 'affirm' && c.judgement_finalized === 'yes'); }
function pmName(m) { return m.spouse_name || m.ex_name || '—'; }
function pmResolved(m) {
  if (m.how_ended === 'Death') return true;
  if (m.how_ended === 'Civil Divorce Only') return false;
  return m.annulment_granted || caseIsConfirmed(m.annulment_case_id);
}
function isMinor(p) { const a = ociaAge(p.dob); return a !== null && a < 18; }
function hasConsent(p) { return !!p.parental_consent; }
function normDocs(p) { return (p.documents || []).map(d => ({ name: d.name, received: d.received ?? d.done ?? false, deletable: d.deletable ?? !d.auto, auto: !!d.auto })); }
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
  return easter ? `Easter ${yr}` : fmtDateYear(p.reception_date);
}

// ── Data ─────────────────────────────────────────────────────────────────────
async function loadTemplates() {
  const { data, error } = await sb.from('ocia_templates').select('candidate_type, documents');
  _templates = {};
  if (!error && data) data.forEach(r => { _templates[r.candidate_type] = r.documents || []; });
  ['catechumen', 'candidate'].forEach(k => { if (!_templates[k]) _templates[k] = JSON.parse(JSON.stringify(FALLBACK_TEMPLATES[k])); });
}
export async function loadOcia() {
  await loadTemplates();
  const { data, error } = await sb.from('sacramental_ocia').select('*').order('created_at', { ascending: false });
  if (error) { console.error('[ocia]', error); return; }
  allOcia = data || [];
  store.allOcia = allOcia;
  const gear = document.getElementById('ocia-gear'); if (gear) gear.style.display = isSacramentCoordinator('ocia') ? '' : 'none';
  updateOciaStats(); renderOciaAlerts(); renderOcia();
}
function updateOciaStats() {
  const active = allOcia.filter(p => !p.archived && p.status_code !== 'inactive');
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('stat-ocia-total', active.length);
  set('stat-ocia-prep', active.filter(p => p.status_code === 'preparation' || p.status_code === 'complete').length);
  const yr = String(new Date().getFullYear());
  set('stat-ocia-received', allOcia.filter(p => p.status_code === 'received' && p.reception_date && String(p.reception_date).startsWith(yr)).length);
}
function renderOciaAlerts() {
  const el = document.getElementById('ocia-alerts'); if (!el) return;
  const flags = allOcia.filter(p => { if (p.archived || p.status_code === 'inactive') return false; if (isMinor(p) && !hasConsent(p)) return true; if ((p.prior_marriages || []).some(m => !pmResolved(m))) return true; return false; });
  if (!flags.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="alert-strip" style="margin-bottom:1rem;flex-direction:column;align-items:flex-start;">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><i class="ti ti-alert-triangle" style="color:var(--gold);font-size:15px;"></i><strong style="font-size:13px;">Attention required</strong></div>
    ${flags.map(p => { const r = []; if (isMinor(p) && !hasConsent(p)) r.push('parental consent outstanding'); if ((p.prior_marriages || []).some(m => !pmResolved(m))) r.push('annulment needed'); return `<div style="font-size:13px;color:var(--navy);margin-bottom:3px;">· <strong>${_esc(p.name)}</strong> — ${r.join(', ')}</div>`; }).join('')}
  </div>`;
}

function setOciaFilter(f, el) {
  ociaFilter = f;
  document.querySelectorAll('#panel-ocia .cf-btn').forEach(b => b.classList.remove('active'));
  el?.classList.add('active');
  renderOcia();
}

function renderOcia() {
  const q = (document.getElementById('ocia-search')?.value || '').toLowerCase();
  const items = allOcia.filter(p => (ociaFilter === 'all' ? true : p.status_code === ociaFilter) && (!q || (p.name || '').toLowerCase().includes(q)));
  const el = document.getElementById('ocia-list'); if (!el) return;
  if (!items.length) { el.innerHTML = '<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">No records found.</div>'; return; }
  const renderUnits = (list) => {
    const groups = {}; list.forEach(p => { if (p.family_group_id) (groups[p.family_group_id] = groups[p.family_group_id] || []).push(p); });
    const seen = new Set(); const units = [];
    list.forEach(p => {
      if (p.family_group_id) {
        if (seen.has(p.family_group_id)) return; seen.add(p.family_group_id);
        const members = groups[p.family_group_id].slice().sort((a, b) => (ociaAge(b.dob) ?? -1) - (ociaAge(a.dob) ?? -1)); // oldest → youngest
        units.push({ members, sort: (lastNameOf(members[0]) + ' ' + (members[0].name || '')).toLowerCase() });
      } else {
        units.push({ members: [p], sort: (p.name || '').toLowerCase() });
      }
    });
    units.sort((a, b) => a.sort.localeCompare(b.sort));
    return units.map(u => u.members.map(renderOciaCard).join('')).join('');
  };
  const active = items.filter(p => !p.archived), archived = items.filter(p => p.archived);
  let html = renderUnits(active);
  if (archived.length) {
    html += `<div style="display:flex;align-items:center;gap:10px;margin:18px 0 10px;"><div style="flex:1;height:.5px;background:var(--stone);"></div><span style="font-size:11px;color:#6B7280;letter-spacing:.07em;text-transform:uppercase;font-weight:500;">Archived</span><div style="flex:1;height:.5px;background:var(--stone);"></div></div>`;
    html += renderUnits(archived);
  }
  el.innerHTML = html;
}

// ── Card ─────────────────────────────────────────────────────────────────────
function renderOciaCard(p) {
  const sm = OCIA_STATUS[p.status_code] || OCIA_STATUS.inquirer;
  const age = ociaAge(p.dob);
  const minorFlag = isMinor(p) && !hasConsent(p);
  const priorFlag = (p.prior_marriages || []).some(m => !pmResolved(m));
  const flagged = minorFlag || priorFlag;
  const exp = ociaExpanded === p.id;
  const recChip = receptionChip(p);
  const fam = p.family_group_id ? `${lastNameOf(p)} Family` : null;
  const docs = normDocs(p); const done = docs.filter(d => d.received).length;
  const progress = docs.length ? Math.round((done / docs.length) * 100) : null;

  let h = `<div class="couple-card${flagged ? ' urgent' : ''}" id="ocia-card-${p.id}" style="border-left:4px solid ${sm.dot};">
    <div class="couple-header" onclick="toggleOcia('${p.id}')">
      <div style="flex:1;min-width:0;">
        <span class="couple-name">${_esc(p.name || '—')}${age !== null ? ` <span style="font-size:12px;color:#6B7280;font-weight:400;">(${age})</span>` : ''}</span>
        <div style="display:flex;gap:6px;margin-top:5px;flex-wrap:wrap;align-items:center;">
          <span style="background:${sm.bg};color:${sm.color};border-radius:20px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:.04em;display:inline-flex;align-items:center;gap:5px;border:1px solid ${sm.color}33;"><span style="width:7px;height:7px;border-radius:50%;background:${sm.dot};display:inline-block;"></span>${sm.label}</span>
          <span style="font-size:11px;color:#4A1D96;background:#EDE9FE;border-radius:20px;padding:2px 8px;">${candType(p) === 'candidate' ? 'Candidate' : 'Catechumen'}</span>
          ${recChip ? `<span style="font-size:11px;background:#FEF9E7;color:#7D6608;border-radius:20px;padding:2px 8px;">🕊 ${recChip}</span>` : ''}
          ${fam ? `<span style="font-size:11px;color:#5B4636;background:#F3ECE0;border-radius:20px;padding:2px 8px;">👪 ${_esc(fam)}</span>` : ''}
          ${progress !== null ? (progress === 100 ? `<span style="font-size:11px;color:#2D6A4F;">✅ docs complete</span>` : `<span style="font-size:11px;color:#922B21;">${done}/${docs.length} docs</span>`) : ''}
        </div>
        ${minorFlag ? `<div style="margin-top:5px;background:#FEF9E7;border-left:3px solid #D4AC0D;border-radius:3px;padding:4px 10px;font-size:12px;font-weight:600;color:#7D6608;">⚠ Parental consent outstanding</div>` : ''}
        ${priorFlag ? `<div style="margin-top:5px;background:#FDEDEC;border-left:3px solid #E74C3C;border-radius:3px;padding:4px 10px;font-size:12px;font-weight:600;color:#922B21;">❗ Prior marriage — annulment needed</div>` : ''}
      </div>
      <span style="font-size:16px;color:#B0A090;">${exp ? '▲' : '▼'}</span>
    </div>`;
  if (exp) h += renderOciaBody(p, docs, progress, done);
  h += `</div>`;
  return h;
}

function renderOciaBody(p, docs, progress, done) {
  let h = `<div class="couple-body">`;
  // detail chips
  h += `<div style="margin-top:10px;">`;
  if (p.dob) h += `<span class="detail-chip">🎂 ${_esc(p.dob)}</span>`;
  if (p.place_of_birth) h += `<span class="detail-chip">📍 ${_esc(p.place_of_birth)}</span>`;
  h += `</div>`;
  if (p.phone || p.email) {
    h += `<div style="margin-top:8px;">`;
    if (p.phone) h += `<a href="tel:${p.phone}" class="contact-chip">📞 ${_esc(p.phone)}</a>`;
    if (p.email) h += `<a href="mailto:${p.email}" class="contact-chip">✉️ ${_esc(p.email)}</a>`;
    h += `</div>`;
  }
  // baptism (candidate) / sponsor
  if (candType(p) === 'candidate') {
    const bcity = p.baptism_city || p.baptism_city_state || '';
    h += `<div class="couple-section-label">Baptism</div><div style="font-size:13px;">${p.baptism_church ? '⛪ ' + _esc(p.baptism_church) : ''}${bcity ? ' · ' + _esc(bcity) : ''}${p.baptism_state ? ', ' + _esc(p.baptism_state) : ''}</div>`;
  }
  const sponsor = p.sponsor_name || p.sponsor1;
  if (sponsor) h += `<div style="font-size:13px;margin-top:6px;">Sponsor: <strong>${_esc(sponsor)}</strong></div>`;
  // minor consent status
  if (isMinor(p)) {
    h += hasConsent(p)
      ? `<div style="margin-top:8px;padding:6px 10px;background:#D8F3DC;border-left:3px solid #2D6A4F;border-radius:3px;font-size:13px;color:#2D6A4F;">✅ Permission received${(p.minor_guardian_name || p.consent_parent_name) ? ' — ' + _esc(p.minor_guardian_name || p.consent_parent_name) : ''}</div>`
      : `<div style="margin-top:8px;padding:6px 10px;background:#FEF9E7;border-left:3px solid #D4AC0D;border-radius:3px;font-size:13px;color:#7D6608;">⚠ Parental/guardian permission outstanding</div>`;
  }
  // prior marriages (read-only with annulment flag + link)
  const pm = p.prior_marriages || [];
  if (pm.length) {
    h += `<div class="couple-section-label">Prior marriages</div>`;
    h += pm.map(m => {
      const lc = m.annulment_case_id ? (store.allCases || []).find(c => c.id === m.annulment_case_id) : null;
      const resolved = pmResolved(m);
      return `<div style="padding:6px 10px;background:${resolved ? '#F8F7F4' : '#FEF9E7'};border-left:3px solid ${resolved ? 'var(--stone)' : '#D4AC0D'};border-radius:3px;margin-bottom:6px;font-size:13px;">
        <div><strong>${_esc(pmName(m))}</strong>${m.how_ended ? ` · ${_esc(m.how_ended)}` : ''}</div>
        <div style="font-size:11px;margin-top:2px;color:${resolved ? '#2D6A4F' : '#854F0B'};">${resolved ? '✅ resolved' : '⚠ annulment needed'}</div>
        ${lc ? `<div style="font-size:11px;color:#1B4F72;margin-top:4px;">🔗 <span onclick="window.expandCase('${lc.id}')" style="cursor:pointer;text-decoration:underline;"><strong>${_esc(lc.petitioner)}${lc.respondent ? ' v. ' + _esc(lc.respondent) : ''}</strong></span></div>` : ''}
      </div>`;
    }).join('');
  }
  // documents (autosave)
  if (docs.length) {
    h += `<div class="couple-section-label" style="margin-top:12px;">Document checklist</div>`;
    if (progress !== null) h += `<div class="prog-bar-wrap"><div class="prog-bar-fill" style="width:${progress}%;background:${progress === 100 ? '#2D6A4F' : 'var(--gold)'};"></div></div><div style="font-size:11px;color:#888;margin-bottom:6px;">${done}/${docs.length} received</div>`;
    h += docs.map((d, i) => `<div class="doc-item" style="padding:4px 6px;display:flex;align-items:center;gap:8px;">
      <span style="font-size:15px;cursor:pointer;" onclick="toggleOciaDoc('${p.id}',${i})">${d.received ? '✅' : '⬜'}</span>
      <span style="flex:1;color:${d.received ? '#2D6A4F' : 'var(--navy)'};cursor:pointer;" onclick="toggleOciaDoc('${p.id}',${i})">${_esc(d.name)}</span>
      ${!d.deletable ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required"></i>` : ''}
    </div>`).join('');
  }
  // notes
  const notes = notesOf(p);
  h += `<div class="couple-section-label" style="margin-top:12px;">Notes</div>
    <div style="display:flex;gap:6px;margin-bottom:8px;"><input type="text" id="on-${p.id}" placeholder="Add a note…" style="flex:1;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();addOciaNoteLog('${p.id}');}" /><button class="btn-secondary" style="padding:.35rem .9rem;font-size:12px;" onclick="addOciaNoteLog('${p.id}')">Add</button></div>`;
  h += notes.length ? notes.map(n => `<div style="font-size:13px;color:#555;margin-bottom:6px;padding:8px 12px;background:#FFF8EE;border-left:3px solid var(--gold);border-radius:3px;"><div style="white-space:pre-wrap;">${_esc(n.note)}</div>${(n.by || n.created_at) ? `<div style="font-size:11px;color:#9CA3AF;margin-top:3px;">${n.created_at ? fmtDate(String(n.created_at).slice(0, 10)) : ''}${n.by ? ' · ' + _esc(n.by) : ''}</div>` : ''}</div>`).join('') : `<div style="font-size:13px;color:#9CA3AF;font-style:italic;padding:.25rem 0;">No notes yet.</div>`;

  h += `<div style="margin-top:12px;text-align:right;"><button class="anl-icon-btn" title="Edit" onclick="openOciaEdit('${p.id}')"><i class="fa-solid fa-pencil"></i></button></div>`;
  h += `</div>`;
  return h;
}

function toggleOcia(id) { ociaExpanded = ociaExpanded === id ? null : id; renderOcia(); }
export async function expandOcia(id) {
  ociaExpanded = id; window.switchPanel('ocia'); await loadOcia();
  document.getElementById('ocia-card-' + id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── Autosave (live card) ─────────────────────────────────────────────────────
async function _patch(id, patch) { const p = allOcia.find(x => x.id === id); if (!p) return null; const { error } = await sb.from('sacramental_ocia').update({ ...patch, updated_at: nowIso() }).eq('id', id); if (error) { alert('Save failed: ' + error.message); return null; } Object.assign(p, patch); return p; }
async function toggleOciaDoc(id, i) {
  const p = allOcia.find(x => x.id === id); if (!p) return;
  const docs = normDocs(p); docs[i].received = !docs[i].received;
  const prevAll = normDocs(p).length > 0 && normDocs(p).every(d => d.received);
  const allDone = docs.length > 0 && docs.every(d => d.received);
  const patch = { documents: docs };
  if (allDone && !prevAll) { const tl = JSON.parse(JSON.stringify(p.timeline || [])); tl.push({ type: 'auto', text: 'All documents received', created_at: nowIso() }); patch.timeline = tl; }
  if (await _patch(id, patch)) renderOcia();
}
async function addOciaNoteLog(id) {
  const inp = document.getElementById('on-' + id); const note = (inp?.value || '').trim(); if (!note) return;
  const p = allOcia.find(x => x.id === id); if (!p) return;
  const log = Array.isArray(p.notes_log) ? JSON.parse(JSON.stringify(p.notes_log)) : [];
  log.push({ note, by: _curUserName(), created_at: nowIso() });
  if (await _patch(id, { notes_log: log })) renderOcia();
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
  let coordId = null;
  try { const { data } = await sb.from('program_coordinators').select('coordinator_ids').eq('program', 'ocia').maybeSingle(); coordId = data?.coordinator_ids?.[0] || null; } catch (_) {}
  _M = newModalState(null, 'catechumen', coordId);
  _ociaOpen(buildModalHtml(null)); _hydrate();
}
function openOciaEdit(id) {
  const p = allOcia.find(x => x.id === id); if (!p) return;
  _M = newModalState(p, candType(p), p.preparation_responsible_id || null);
  _ociaOpen(buildModalHtml(p)); _hydrate();
}
function newModalState(p, type, coordId) {
  return {
    id: p?.id || null, isEdit: !!p, type,
    respId: p?.preparation_responsible_id || coordId || '', respOther: !p?.preparation_responsible_id && !!p?.preparation_responsible_override,
    docs: p ? normDocs(p) : computeTemplateDocs(type),
    prior: p?.prior_marriages?.length ? JSON.parse(JSON.stringify(p.prior_marriages)) : [],
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
function _caseLabel(id) { const r = (store.allCases || []).find(x => x.id === id); return r ? `${r.petitioner || ''}${r.respondent ? ' v. ' + r.respondent : ''}` : 'Annulment case'; }

function _nameParts(p) {
  const parts = (p?.name || '').trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] || '', middle: '', last: '' };
  if (parts.length === 2) return { first: parts[0], middle: '', last: parts[1] };
  return { first: parts[0], middle: parts.slice(1, -1).join(' '), last: parts[parts.length - 1] };
}

function buildModalHtml(p) {
  const isEdit = _M.isEdit;
  const np = _nameParts(p);
  const age = ociaAge(p?.dob);
  const respOpts = clergyPersonnel().map(c => `<option value="${c.id}"${_M.respId === c.id ? ' selected' : ''}>${_esc(c.name)}</option>`).join('');
  const instOpts = (store.institutions || []).map(i => `<option value="${i.name}"${p?.reception_church === i.name ? ' selected' : ''}>${_esc(i.name)}</option>`).join('');

  let h = `<div class="modal-title">${isEdit ? 'Edit OCIA File' : 'New OCIA Candidate'}</div>`;

  // Section 1 — Candidate Type toggle buttons
  h += _sectionHead('Candidate Type');
  h += `<div style="display:flex;gap:10px;">
    <button type="button" id="ot-catechumen" class="ocia-type-btn${_M.type === 'catechumen' ? ' active' : ''}" onclick="ociaSetType('catechumen')" style="flex:1;">Catechumen<br><span style="font-size:11px;font-weight:400;opacity:.8;">unbaptized</span></button>
    <button type="button" id="ot-candidate" class="ocia-type-btn${_M.type === 'candidate' ? ' active' : ''}" onclick="ociaSetType('candidate')" style="flex:1;">Candidate<br><span style="font-size:11px;font-weight:400;opacity:.8;">already baptized</span></button>
  </div>`;

  // Section 2 — Person responsible
  h += _sectionHead('Person Responsible');
  h += `<label>Person Responsible</label><select id="of-resp" onchange="ociaRespChange(this.value)"><option value="">— Select —</option>${respOpts}<option value="__other"${_M.respOther ? ' selected' : ''}>Other…</option></select>
    <div id="of-resp-other-wrap" style="display:${_M.respOther ? 'block' : 'none'};">${_input('of-resp-other', 'Name', p?.preparation_responsible_override || '')}</div>`;

  // Section 3 — Candidate info
  h += _sectionHead('Candidate Information');
  h += _row(_input('of-first', 'First Name', np.first), _input('of-middle', 'Middle', np.middle), _input('of-last', 'Last Name', np.last));
  h += _row(_input('of-phone', 'Cell Phone', p?.phone || ''), _input('of-email', 'Email', p?.email || ''));
  h += `<label>Date of Birth</label><input type="${(p?.dob && /^\d{4}-\d{2}-\d{2}/.test(p.dob)) ? 'date' : 'text'}" id="of-dob" value="${_esc(p?.dob || '')}" placeholder="YYYY-MM-DD" oninput="ociaDobChange()" />`;
  h += `<div id="of-minor-wrap" style="display:${age !== null && age <= 17 ? 'block' : 'none'};">
    ${_toggle('of-consent', 'Parent/Guardian Permission Granted', !!p?.parental_consent)}
    ${_input('of-guardian', 'Parent/Guardian Name', p?.minor_guardian_name || p?.consent_parent_name || '')}
    ${_input('of-permdate', 'Date Permission Received', p?.minor_permission_date || p?.consent_date || '', 'date')}
  </div>`;

  // Section 4 — Baptism (candidate only)
  h += `<div id="of-baptism-section" style="display:${_M.type === 'candidate' ? 'block' : 'none'};">`;
  h += _sectionHead('Baptism');
  h += _input('of-bchurch', 'Church of Baptism', p?.baptism_church || '');
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
    h += _sectionHead('Status & Reception');
    h += `<label>Status</label><select id="of-status" onchange="ociaStatusChange(this.value)">${Object.entries(OCIA_STATUS).map(([k, v]) => `<option value="${k}"${(p?.status_code || 'inquirer') === k ? ' selected' : ''}>${v.label}</option>`).join('')}</select>`;
    const showRec = p?.status_code === 'received' || p?.status_code === 'complete';
    const easter = nextEaster(); const easterVal = easter.toISOString().slice(0, 10);
    h += `<div id="of-rec-wrap" style="display:${showRec ? 'block' : 'none'};" data-easter="${easterVal}">
      ${_toggle('of-rec-other', 'Other date (not Easter Vigil)', _M.recOther, 'ociaRecOtherChange()')}
      <div id="of-rec-date-wrap" style="display:${_M.recOther ? 'block' : 'none'};">${_input('of-rec-date', 'Reception Date', (p?.reception_date && _M.recOther) ? p.reception_date : '', 'date')}</div>
      <div id="of-rec-easter-note" style="display:${_M.recOther ? 'none' : 'block'};font-size:12px;color:#7D6608;margin-top:6px;">Reception at the Easter Vigil — ${fmtDateYear(easterVal)}</div>
      <label style="margin-top:.75rem;">Church of Reception</label><select id="of-rec-church"><option value="">— Select —</option>${instOpts}<option value="__other"${(p?.reception_church && !(store.institutions || []).some(i => i.name === p.reception_church)) ? ' selected' : ''}>Other…</option></select>
      ${_sectionHead('Sacraments to be Received at Reception')}
      ${ociaSacramentRows(p)}
    </div>`;
    h += _toggle('of-archive', 'Archive this file', !!p?.archived);
  }

  h += `<div class="modal-actions" style="justify-content:space-between;">
    ${isEdit ? `<button class="btn-delete" onclick="ociaDeletePerson('${_M.id}')">Delete</button>` : '<span></span>'}
    <div style="display:flex;gap:8px;"><button class="btn-secondary" onclick="ociaCloseModal()">Cancel</button><button class="btn-primary" onclick="ociaSave()">${isEdit ? 'Save' : 'Create File'}</button></div>
  </div>`;
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

function _hydrate() { renderModalDocs(); renderPrior(); renderFamilyChip(); }
function renderModalDocs() {
  const el = document.getElementById('of-docs'); if (!el) return;
  el.innerHTML = _M.docs.map((d, i) => `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;">
    <input type="checkbox" ${d.received ? 'checked' : ''} onchange="ociaDocReceived(${i},this.checked)" style="width:15px;height:15px;accent-color:var(--cardinal);" />
    <span style="flex:1;font-size:13px;color:var(--navy);">${_esc(d.name)}</span>
    ${d.deletable === false ? `<i class="fa-solid fa-lock" style="color:#C9C2B6;font-size:11px;" title="Required"></i>` : `<button onclick="ociaRemoveDoc(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:13px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">×</button>`}
  </div>`).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No documents.</div>`;
}
function renderPrior() {
  const wrap = document.getElementById('of-prior-wrap'); if (!wrap) return;
  wrap.innerHTML = _M.prior.map((m, i) => `<div style="background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.6rem;margin-bottom:.5rem;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><span style="font-size:12px;font-weight:600;color:#555;">Prior marriage ${i + 1}</span><button onclick="ociaRemovePrior(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:12px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">× Remove</button></div>
    ${_input(`of-pm-name-${i}`, 'Prior spouse name', m.spouse_name || m.ex_name || '')}
    <label>How ended</label><select id="of-pm-ended-${i}" onchange="ociaPriorEnded(${i},this.value)">${HOW_ENDED.map(o => `<option${m.how_ended === o ? ' selected' : ''}>${o}</option>`).join('')}</select>
    <div id="of-pm-annul-${i}" style="display:${m.how_ended === 'Annulment' ? 'block' : 'none'};position:relative;">
      <input type="text" id="of-pm-annulsearch-${i}" placeholder="Link annulment case…" autocomplete="off" oninput="ociaAnnulSearch(${i})" style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;margin-top:6px;" />
      <div id="of-pm-annulresults-${i}" class="anl-link-results" style="display:none;"></div>
      <div id="of-pm-annulchip-${i}" style="margin-top:6px;">${m.annulment_case_id ? annulChip(i, m.annulment_case_id) : ''}</div>
    </div>
  </div>`).join('') + `<button class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;" onclick="ociaAddPrior()">+ Add prior marriage</button>`;
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
function ociaRespChange(v) { _M.respOther = v === '__other'; document.getElementById('of-resp-other-wrap').style.display = _M.respOther ? 'block' : 'none'; }
function ociaDobChange() { const age = ociaAge(document.getElementById('of-dob').value); document.getElementById('of-minor-wrap').style.display = (age !== null && age <= 17) ? 'block' : 'none'; }
function ociaStatusChange(v) { const w = document.getElementById('of-rec-wrap'); if (w) w.style.display = (v === 'received' || v === 'complete') ? 'block' : 'none'; }
function ociaRecOtherChange() { _M.recOther = document.getElementById('of-rec-other').checked; document.getElementById('of-rec-date-wrap').style.display = _M.recOther ? 'block' : 'none'; document.getElementById('of-rec-easter-note').style.display = _M.recOther ? 'none' : 'block'; }
function ociaPriorToggle() { const on = document.getElementById('of-prior-toggle').checked; document.getElementById('of-prior-wrap').style.display = on ? 'block' : 'none'; if (on && !_M.prior.length) { _M.prior = [{ spouse_name: '', how_ended: 'Death', annulment_case_id: null }]; renderPrior(); } }
function _syncPrior() { _M.prior = _M.prior.map((m, i) => ({ spouse_name: document.getElementById(`of-pm-name-${i}`)?.value.trim() || '', how_ended: document.getElementById(`of-pm-ended-${i}`)?.value || 'Death', annulment_case_id: m.annulment_case_id || null })); }
function ociaAddPrior() { _syncPrior(); _M.prior.push({ spouse_name: '', how_ended: 'Death', annulment_case_id: null }); renderPrior(); }
function ociaRemovePrior(i) { _syncPrior(); _M.prior.splice(i, 1); renderPrior(); }
function ociaPriorEnded(i, v) { document.getElementById(`of-pm-annul-${i}`).style.display = v === 'Annulment' ? 'block' : 'none'; _syncPrior(); }
function ociaDocReceived(i, v) { _M.docs[i].received = v; }
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
  box?.querySelectorAll('.anl-link-opt').forEach(o => o.addEventListener('mousedown', e => { e.preventDefault(); _syncPrior(); _M.prior[i].annulment_case_id = o.dataset.id; box.style.display = 'none'; document.getElementById(`of-pm-annulchip-${i}`).innerHTML = annulChip(i, o.dataset.id); }));
}
function ociaRemoveAnnul(i) { _syncPrior(); _M.prior[i].annulment_case_id = null; document.getElementById(`of-pm-annulchip-${i}`).innerHTML = ''; }

// ── Save ─────────────────────────────────────────────────────────────────────
function _v(id) { const e = document.getElementById(id); return e ? e.value.trim() : ''; }
function _chk(id) { return !!document.getElementById(id)?.checked; }
async function ociaSave() {
  _syncPrior();
  const name = [_v('of-first'), _v('of-middle'), _v('of-last')].filter(Boolean).join(' ');
  if (!name) { alert('Candidate name is required.'); return; }
  const type = _M.type;
  const respSel = document.getElementById('of-resp')?.value || '';
  const age = ociaAge(_v('of-dob'));
  const minor = age !== null && age <= 17;

  // family group resolution
  let familyGroupId = null, linkTargetToUpdate = null;
  if (_M.family) {
    if (_M.family.group_id) familyGroupId = _M.family.group_id;
    else { familyGroupId = (crypto?.randomUUID?.() || String(Date.now())); if (_M.family.target_id) linkTargetToUpdate = _M.family.target_id; }
  }

  const payload = {
    name, candidate_type: type, baptismal_status: type === 'candidate' ? 'baptized' : 'unbaptized',
    preparation_responsible_id: respSel && respSel !== '__other' ? respSel : null,
    preparation_responsible_override: respSel === '__other' ? (_v('of-resp-other') || null) : null,
    phone: _v('of-phone') || null, email: _v('of-email') || null, dob: _v('of-dob') || null,
    parental_consent: minor ? _chk('of-consent') : false,
    minor_guardian_name: minor ? (_v('of-guardian') || null) : null,
    minor_permission_date: minor ? (_v('of-permdate') || null) : null,
    consent_parent_name: minor && _chk('of-consent') ? (_v('of-guardian') || null) : null,
    consent_date: minor && _chk('of-consent') ? (_v('of-permdate') || null) : null,
    baptism_church: type === 'candidate' ? (_v('of-bchurch') || null) : null,
    baptism_city: type === 'candidate' ? (_v('of-bcity') || null) : null,
    baptism_state: type === 'candidate' ? (_v('of-bstate') || null) : null,
    baptism_country: type === 'candidate' ? (_v('of-bcountry') || null) : null,
    sponsor_name: _v('of-sponsor') || null,
    prior_marriages: _M.prior.filter(m => m.spouse_name),
    documents: _M.docs,
    family_group_id: familyGroupId,
    updated_at: nowIso(),
  };

  if (_M.isEdit) {
    const prior = allOcia.find(x => x.id === _M.id);
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
    const tl = JSON.parse(JSON.stringify(prior?.timeline || []));
    if (prior && prior.status_code !== 'received' && newStatus === 'received') tl.push({ type: 'auto', text: 'Received', created_at: nowIso() });
    payload.timeline = tl;
    const { error } = await sb.from('sacramental_ocia').update(payload).eq('id', _M.id);
    if (error) { alert('Save failed: ' + error.message); return; }
    if (linkTargetToUpdate) await sb.from('sacramental_ocia').update({ family_group_id: familyGroupId }).eq('id', linkTargetToUpdate);
    logActivity({ action: 'updated OCIA record', entityType: 'ocia', entityName: name, contextType: 'ocia', contextId: _M.id });
    ociaCloseModal(); await loadOcia();
  } else {
    payload.status_code = 'inquirer';
    payload.archived = false;
    payload.timeline = [{ type: 'auto', text: 'File opened', created_at: nowIso() }];
    const { error } = await sb.from('sacramental_ocia').insert(payload);
    if (error) { alert('Create failed: ' + error.message); return; }
    if (linkTargetToUpdate) await sb.from('sacramental_ocia').update({ family_group_id: familyGroupId }).eq('id', linkTargetToUpdate);
    logActivity({ action: 'added OCIA candidate', entityType: 'ocia', entityName: name, contextType: 'ocia' });
    const { data: { user } } = await sb.auth.getUser();
    const uids = await getUserIdsForSacrament('ocia');
    notifyUsers(uids, user?.id, `New OCIA candidate added: ${name}`, 'info', 'ocia');
    ociaCloseModal(); await loadOcia();
  }
}
async function ociaDeletePerson(id) {
  if (!confirm('Permanently delete this record? This cannot be undone.')) return;
  const { error } = await sb.from('sacramental_ocia').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  ociaCloseModal(); await loadOcia();
}

// ── Templates ────────────────────────────────────────────────────────────────
let _tplState = null, _tplActive = 'catechumen';
function openOciaTemplates() { _tplState = JSON.parse(JSON.stringify(_templates)); _tplActive = 'catechumen'; _ociaOpen(buildTplHtml()); renderTplDocs(); }
function buildTplHtml() {
  const tabs = [['catechumen', 'Catechumen'], ['candidate', 'Candidate']].map(([v, l]) => `<button class="anl-tpl-tab${_tplActive === v ? ' active' : ''}" data-v="${v}" onclick="ociaTplTab('${v}')">${l}</button>`).join('');
  return `<div class="modal-title">OCIA Templates</div>
    <div style="display:flex;gap:4px;margin-bottom:1rem;border-bottom:.5px solid var(--stone);padding-bottom:8px;">${tabs}</div>
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
  const btn = document.querySelector('#ocia-overlay .modal-actions .btn-primary');
  if (btn) { btn.textContent = 'Saved ✓'; btn.style.background = '#2D6A4F'; setTimeout(() => { btn.textContent = 'Save Template'; btn.style.background = ''; }, 1600); }
}

Object.assign(window, {
  renderOcia, setOciaFilter, toggleOcia, expandOcia, expandCase,
  openOciaCreate, openOciaEdit, openOciaTemplates, ociaCloseModal,
  toggleOciaDoc, addOciaNoteLog,
  ociaSetType, ociaRespChange, ociaDobChange, ociaStatusChange, ociaRecOtherChange,
  ociaPriorToggle, ociaAddPrior, ociaRemovePrior, ociaPriorEnded,
  ociaDocReceived, ociaRemoveDoc, ociaAddDoc,
  ociaFamilySearch, ociaRemoveFamily, ociaAnnulSearch, ociaRemoveAnnul,
  ociaSave, ociaDeletePerson,
  ociaTplTab, ociaTplAdd, ociaTplRemove, ociaTplSave,
});
