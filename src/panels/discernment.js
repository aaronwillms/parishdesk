// ── Discernment Tracker — private, pastor-facing vocations module ───────────
// Master-detail (left card column = the daily driver; right = the file pane).
// JS-ENFORCED ACCESS (NOT RLS), two axes (see roles.canAccessDiscernment +
// canViewDiscerner/canWriteDiscerner below):
//   1. PANEL ACCESS — super-admin + panel_grants('discernment') holders. They
//      read AND write every parish discernment file (collaborators).
//   2. % FILE-GRANT — record_grants('discerner', id) hands ONE file READ-ONLY to
//      a non-panel user (e.g. a diocesan vocations director). Rides the % layer.
//
// SNAPSHOT DISCIPLINE: current stage = to_stage of the most recent transition
// (never stored); next contact = soonest incomplete follow-up (derived). Stages
// are frozen TEXT in the transition log, so the ladder constant can change
// without rewriting history.
//
// AESTHETIC: this is a Discernment-SPECIFIC layout (see the shell-reuse note at
// the bottom) that REUSES the sacramental shell's CSS classes + tokens +
// chipHtml, so it is visually identical to the sacramental panels while
// supporting two independent filter axes, the move-stage control, and per-file
// read-only gating that the config-driven shell does not express cleanly.

import { sb, withWriteRetry, serializeWrite, insertWithRetry, deleteWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { logActivity, reportWriteError, todayCST, formatDateDisplay, daysUntil } from '../utils.js';
import { isSuperAdmin, canAccessDiscernment } from '../roles.js';
import { chipHtml } from '../sacramental/panelShell.js';
import { ensureIdentities, userName, fetchGrantRow, loadMyGrants, hasMyGrantForLink } from '../ui/grants.js';
import { institutionAddressAutofill, institutionOptionsHtml, institutionSelectedName, institutionAddressSync } from '../sacramental/churchLocation.js';
import { buildOfficiantField, readOfficiantValue } from '../sacramental/officiantField.js';
import { noteEditedMarker, promptNoteEdit } from '../sacramental/noteEdit.js';
import {
  ALL_STAGES, STAGE_LADDER, TERMINAL_STAGES, STARTING_STAGE, stageChipStyle,
  VOCATION_TYPES, vocationLabel, currentStage as deriveStage, nextFollowup as deriveNextFollowup,
  isOverdue, canViewDiscernerCore, canWriteDiscernerCore,
} from '../discernment/derive.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// 50-state dropdown — same list + 2-letter-code value format the sacramental
// panels use (baptism/firstcomm/confirmation/ocia/annulment _stateSelect), so the
// stored value stays consistent across the app. Returns the <select> only (the
// caller supplies its own <label>).
const US_STATES = ['AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC'];
function _stateSelect(id, val) {
  return `<select id="${id}"><option value="">—</option>${US_STATES.map(s => `<option${s === val ? ' selected' : ''}>${s}</option>`).join('')}</select>`;
}

// ── Module state ─────────────────────────────────────────────────────────────
let _discerners = [];
let _notesByD = {}, _transByD = {}, _followByD = {};
let _pins = new Set();   // discerner ids the CURRENT user has pinned (per-user)
let _authUserId = null;
let _selectedId = null;
let _stageFilter = 'all', _vocFilter = 'all', _search = '', _showArchived = false;
let _M = null;          // create/edit modal state
let _hashBound = false;

const nowIso = () => new Date().toISOString();

// ── Person model — INLINE only (directory-person linking was removed; discerners
// never see their own file, so linking added no value). Name/contact always live
// on the discerner row. `name` is the denormalized combined first/middle/last
// (kept in sync on save) used by the card + the % grantable-record search.
function discernerName(d) {
  const parts = [d.first_name, d.middle_name, d.last_name].filter(Boolean).join(' ');
  return parts || d.name || 'Unnamed discerner';
}
function discernerContact(d) { return [d.phone || '', d.email || ''].filter(Boolean).join(' · '); }
function isArchived(d) { return !!d.archived_at; }
// Last name for the card sort (last_name field; else the last token of the
// combined name). Cards sort by last name ONLY (no status/stage/vocation order).
function discernerLastName(d) {
  if (d.last_name) return d.last_name;
  const parts = String(d.name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}
function byLastName(a, b) {
  return discernerLastName(a).toLowerCase().localeCompare(discernerLastName(b).toLowerCase())
    || discernerName(a).toLowerCase().localeCompare(discernerName(b).toLowerCase());
}
// Per-user pin (the current user's pins only; from discernment_pins).
function isPinned(d) { return _pins.has(d.id); }
function parentsOf(d) { return Array.isArray(d.parents) ? d.parents.filter(p => p && (p.first || p.last || p.phone || p.email)) : []; }
// Auto-calculated age from DOB (parish timezone), or null.
function ageOf(dob) {
  if (!dob) return null;
  const d = new Date(dob); if (isNaN(d)) return null;
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: store.parishSettings?.timezone || 'America/Chicago' }));
  let a = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) a--;
  return a;
}
// Split a legacy combined `name` into parts (back-compat for rows predating the split).
function nameParts(d) {
  if (d.first_name || d.middle_name || d.last_name) return { first: d.first_name || '', middle: d.middle_name || '', last: d.last_name || '' };
  const parts = String(d.name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { first: '', middle: '', last: '' };
  if (parts.length === 1) return { first: parts[0], middle: '', last: '' };
  if (parts.length === 2) return { first: parts[0], middle: '', last: parts[1] };
  return { first: parts[0], middle: parts.slice(1, -1).join(' '), last: parts[parts.length - 1] };
}

// ── Derived snapshots (delegate to the pure helpers) ─────────────────────────
function transitionsOf(id) { return _transByD[id] || []; }
function currentStageOf(d) { return deriveStage(transitionsOf(d.id)); }
function nextFollowupOf(d) { return deriveNextFollowup(_followByD[d.id] || []); }
function notesOf(d) {
  return (_notesByD[d.id] || []).slice().sort((a, b) =>
    String(b.note_date || b.created_at || '').localeCompare(String(a.note_date || a.created_at || '')));
}
function followupsOf(d) {
  return (_followByD[d.id] || []).slice().sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;                 // open first
    return String(a.due_date || '').localeCompare(String(b.due_date || ''));
  });
}
function historyOf(d) {
  // Newest-recorded first (created_at, falling back to transitioned_at) so the top
  // of the list matches the derived current-stage chip.
  return transitionsOf(d.id).slice().sort((a, b) =>
    String(b.created_at || b.transitioned_at || '').localeCompare(String(a.created_at || a.transitioned_at || '')));
}

// ── Access wrappers (live role calls feed the pure cores in derive.js) ───────
function _isCreator(d) { return !!(d && _authUserId && d.author_id === _authUserId); }
export function canViewDiscerner(d) {
  if (!d) return false;
  return canViewDiscernerCore({
    isCreator: _isCreator(d), isSuper: isSuperAdmin(),
    hasPanelAccess: canAccessDiscernment(), hasGrant: hasMyGrantForLink('discerner', d.id),
  });
}
export function canWriteDiscerner(d) {
  if (!d) return false;
  return canWriteDiscernerCore({
    isCreator: _isCreator(d), isSuper: isSuperAdmin(), hasPanelAccess: canAccessDiscernment(),
  });
}
// Creating a new file requires panel access (or super-admin) — a %-grantee
// (read-only, single file) can never create.
function canCreate() { return canAccessDiscernment(); }

// ── Data ─────────────────────────────────────────────────────────────────────
// One fetch of the four tables, indexed by discerner id. RLS is disabled on
// these tables (client-gated), so the anon key reads all parish rows; the view
// gate is applied in visibleDiscerners(). Until the migration lands these
// queries error (table missing) → caught → empty state. PENDING the migration.
export async function loadDiscernmentData() {
  const { data: { user } } = await sb.auth.getUser();
  _authUserId = user?.id || null;
  await loadMyGrants().catch(() => {});       // grant cache (powers the %-view path)
  await ensureIdentities().catch(() => {});    // author display names

  const { data: ds, error } = await sb.from('discerners').select('*').order('created_at', { ascending: false });
  if (error) { console.warn('[discernment] load (pending migration?):', error.message); _discerners = []; _notesByD = _transByD = _followByD = {}; return []; }
  _discerners = ds || [];
  _notesByD = {}; _transByD = {}; _followByD = {};
  const ids = _discerners.map(d => d.id);
  if (ids.length) {
    const [nt, tr, fu] = await Promise.all([
      sb.from('discernment_notes').select('*').in('discerner_id', ids),
      sb.from('discernment_stage_transitions').select('*').in('discerner_id', ids),
      sb.from('discernment_followups').select('*').in('discerner_id', ids),
    ]);
    (nt.data || []).forEach(n => (_notesByD[n.discerner_id] = _notesByD[n.discerner_id] || []).push(n));
    (tr.data || []).forEach(t => (_transByD[t.discerner_id] = _transByD[t.discerner_id] || []).push(t));
    (fu.data || []).forEach(f => (_followByD[f.discerner_id] = _followByD[f.discerner_id] || []).push(f));
  }
  // This user's pins only (per-user). Pre-migration this errors → empty set.
  _pins = new Set();
  if (_authUserId) {
    const { data: pins } = await sb.from('discernment_pins').select('discerner_id').eq('user_id', _authUserId);
    (pins || []).forEach(p => _pins.add(p.discerner_id));
  }
  return _discerners;
}

// ── Entry point (nav loader) ─────────────────────────────────────────────────
export async function loadDiscernment() {
  await loadDiscernmentData();
  applyHash();
  render();
  if (!_hashBound) { window.addEventListener('hashchange', onHashChange); _hashBound = true; }
}
function onHashChange() { applyHash(); render(); }
function applyHash() {
  const m = (location.hash || '').match(/^#\/discernment(?:\/([^/]+))?$/);
  if (!m) return;
  _selectedId = m[1] || null;
}
function selectDiscerner(id) { location.hash = id ? `#/discernment/${id}` : '#/discernment'; }

// Cross-link entry — open one discerner file (used by a % controller / future
// link chip). Switches to the panel and deep-links; the view gate still applies.
export async function expandDiscerner(id) {
  selectDiscerner(id);
  window.switchPanel('discernment');
}

// ── Render ─────────────────────────────────────────────────────────────────
function root() { return document.getElementById('discernment-root'); }
function render() {
  const el = root(); if (!el) return;
  let shell = el.querySelector('#disc-shell');
  if (!shell) {
    // Built once: confidentiality banner + vocation stat row + the master-detail shell.
    el.innerHTML = `
      <div class="confid-notice"><i class="fa-solid fa-lock" style="margin-right:7px;"></i>Discernment information is strictly confidential. Access is limited to clergy and those responsible for discernment accompaniment.</div>
      <div class="stat-row" id="disc-stats"></div>
      <div class="sac-shell" id="disc-shell"></div>`;
    shell = el.querySelector('#disc-shell');
    shell.addEventListener('click', onShellClick);
    shell.addEventListener('input', onShellInput);
    shell.addEventListener('change', onShellChange);
  }
  renderStats();
  shell.classList.toggle('detail-open', !!_selectedId);
  shell.innerHTML = `<div class="sac-list">${listHtml()}</div><div class="sac-detail">${detailHtml()}</div>`;
  // Grantee header (axis 2) is async — fill it after the sync paint.
  const d = selected();
  if (d) fillGranteeHeader(d);
}
// Stat row — counts of active (non-archived, viewable) discerners by vocation type.
function renderStats() {
  const el = document.getElementById('disc-stats'); if (!el) return;
  const active = _discerners.filter(d => canViewDiscerner(d) && !isArchived(d));
  const c = (t) => active.filter(d => d.vocation_type === t).length;
  el.innerHTML = `
    <div class="stat-card"><div class="stat-num">${c('priesthood')}</div><div class="stat-label">Priesthood</div></div>
    <div class="stat-card"><div class="stat-num">${c('diaconate')}</div><div class="stat-label">Diaconate</div></div>
    <div class="stat-card"><div class="stat-num">${c('religious_life')}</div><div class="stat-label">Religious Life</div></div>`;
}
function selected() { return _discerners.find(x => x.id === _selectedId) || null; }

function visibleDiscerners() {
  const q = _search.trim().toLowerCase();
  return _discerners.filter(d => {
    if (!canViewDiscerner(d)) return false;                       // axis 1+2 view gate
    if (!_showArchived && isArchived(d)) return false;
    if (_vocFilter !== 'all' && d.vocation_type !== _vocFilter) return false;
    if (_stageFilter !== 'all') {
      const st = currentStageOf(d);
      if (_stageFilter === '__none' ? st != null : st !== _stageFilter) return false;
    }
    if (q && !discernerName(d).toLowerCase().includes(q)) return false;
    return true;
  }).sort(byLastName);   // LAST NAME only — no status/stage/vocation ordering
}

function listHtml() {
  const vocPills = [['all', 'All'], ...Object.entries(VOCATION_TYPES)].map(([k, label]) =>
    `<button class="cf-btn${_vocFilter === k ? ' active' : ''}" data-act="voc" data-key="${k}">${esc(label)}</button>`).join('');
  const stageOpts = [['all', 'All stages'], ['__none', 'No stage yet'], ...ALL_STAGES.map(s => [s, s])]
    .map(([v, l]) => `<option value="${esc(v)}"${_stageFilter === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  return `
    <div class="sac-list-head">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:.55rem;">
        <span class="sac-list-title">Discerners</span>
        ${canCreate() ? `<button class="btn-primary" style="padding:.3rem .7rem;font-size:12px;white-space:nowrap;" data-act="new">+ New</button>` : ''}
      </div>
      <input type="text" id="disc-search" placeholder="Search by name…" value="${esc(_search)}"
        style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;outline:none;" />
      <div style="display:flex;gap:5px;margin-top:.5rem;flex-wrap:wrap;align-items:center;">${vocPills}</div>
      <div style="display:flex;gap:6px;margin-top:.5rem;align-items:center;">
        <select id="disc-stage-filter" style="flex:1;min-width:0;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.35rem .5rem;font-size:12px;font-family:'Inter',sans-serif;background:#fff;">${stageOpts}</select>
        <button class="cf-btn" data-act="toggle-archived" title="Show archived" style="${_showArchived ? 'background:var(--navy);color:var(--gold);' : ''}"><i class="fa-solid fa-box-archive"></i></button>
      </div>
    </div>
    <div class="sac-list-scroll">${listBodyHtml()}</div>`;
}

function listBodyHtml() {
  const rows = visibleDiscerners();   // already last-name-sorted
  if (!rows.length) return `<div style="font-size:13px;color:#6B7280;padding:.5rem;">${_discerners.length ? 'No discerners match.' : 'No discernment files yet.'}</div>`;
  // Pinned float to the top (last-name-sorted among themselves, since `rows` is
  // already sorted); the unpinned rest follow, also last-name-sorted.
  const pinned = rows.filter(isPinned);
  const rest = rows.filter(d => !isPinned(d));
  return [...pinned, ...rest].map(cardHtml).join('');
}

function cardHtml(d) {
  const sel = _selectedId === d.id;
  const stage = currentStageOf(d);
  // Chip order: [Stage] [Vocation Type].
  const chips = [];
  if (stage) chips.push({ label: stage, tone: 'neutral', style: stageChipStyle(stage) });
  chips.push({ label: vocationLabel(d.vocation_type), tone: 'neutral' });
  if (isArchived(d)) chips.push({ label: 'Archived', tone: 'neutral', style: 'background:#F2F3F4;color:#616A6B;' });
  const age = ageOf(d.dob);
  const title = discernerName(d) + (age !== null ? ` (${age})` : '');
  const fu = nextFollowupOf(d);
  const today = todayCST();
  let next = '';
  if (fu) {
    const over = isOverdue(fu.due_date, today);
    const du = daysUntil(fu.due_date);
    const rel = over ? `${Math.abs(du)}d overdue` : (du === 0 ? 'today' : `in ${du}d`);
    next = `<div style="font-size:11.5px;margin-top:3px;color:${over ? 'var(--cardinal)' : '#6B7280'};font-weight:${over ? '600' : '400'};">
      <i class="fa-solid fa-bell" style="font-size:10px;margin-right:3px;"></i>Next contact: ${esc(formatDateDisplay(fu.due_date))} (${rel})</div>`;
  } else {
    next = `<div style="font-size:11.5px;margin-top:3px;color:#9CA3AF;font-style:italic;">No follow-up scheduled</div>`;
  }
  const pinned = isPinned(d);
  const pinBtn = `<button data-act="toggle-pin" data-id="${d.id}" title="${pinned ? 'Unpin' : 'Pin to top'}" aria-label="${pinned ? 'Unpin' : 'Pin to top'}" style="background:none;border:none;cursor:pointer;padding:2px 4px;flex-shrink:0;align-self:flex-start;line-height:1;">
    <i class="fa-solid fa-thumbtack" style="font-size:12px;color:${pinned ? 'var(--cardinal)' : '#C9C2B6'};${pinned ? '' : 'transform:rotate(45deg);'}"></i>
  </button>`;
  return `<div class="sac-item${sel ? ' selected' : ''}" data-act="open" data-id="${d.id}">
    <div class="sac-item-row">
      <div style="flex:1;min-width:0;">
        <div class="sac-item-title">${esc(title)}</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-top:5px;">${chips.map(chipHtml).join('')}</div>
        ${next}
      </div>
      ${pinBtn}
    </div>
  </div>`;
}

// ── Detail / file pane ───────────────────────────────────────────────────────
function detailHtml() {
  if (!_selectedId) {
    return `<div class="sac-empty"><i class="fa-solid fa-person-praying" style="font-size:30px;opacity:.4;"></i><div style="font-size:14px;">Select a discerner to open their file</div></div>`;
  }
  const d = selected();
  if (!d || !canViewDiscerner(d)) return `<div class="sac-empty"><div>File not found.</div></div>`;

  const write = canWriteDiscerner(d);
  const stage = currentStageOf(d);
  // Chip order: [Stage] [Vocation Type].
  const chips = [];
  if (stage) chips.push({ label: stage, tone: 'neutral', style: stageChipStyle(stage) });
  chips.push({ label: vocationLabel(d.vocation_type), tone: 'neutral' });
  if (isArchived(d)) chips.push({ label: 'Archived', tone: 'neutral', style: 'background:#F2F3F4;color:#616A6B;' });
  const contact = discernerContact(d);
  const age = ageOf(d.dob);

  const actions = write ? `
    <button class="btn-secondary sac-detail-btn" data-act="move-stage" aria-label="Move stage"><i class="fa-solid fa-arrow-right-arrow-left"></i> <span class="sac-btn-label">Move stage</span></button>
    <button class="btn-secondary sac-detail-btn" data-act="toggle-archive" aria-label="${isArchived(d) ? 'Unarchive' : 'Archive'}"><i class="fa-solid fa-box-archive"></i> <span class="sac-btn-label">${isArchived(d) ? 'Unarchive' : 'Archive'}</span></button>
    <button class="btn-primary sac-detail-btn" data-act="edit" aria-label="Edit"><i class="fa-solid fa-pencil"></i> <span class="sac-btn-label">Edit</span></button>
    <button class="btn-secondary sac-detail-btn" data-act="delete" aria-label="Delete" style="color:#C0392B;border-color:#F2C9D1;"><i class="fa-solid fa-trash"></i> <span class="sac-btn-label">Delete</span></button>` : '';

  return `
    <div id="disc-grantee"></div>
    <div class="sac-detail-head">
      <button class="sac-back" data-act="back" aria-label="Back">‹</button>
      <div class="sac-avatar"><i class="fa-solid fa-cross"></i></div>
      <div class="sac-detail-main">
        <div class="sac-detail-name">${esc(discernerName(d))}${age !== null ? ` <span style="font-size:16px;color:#9CA3AF;font-weight:400;">(${age})</span>` : ''}</div>
        ${contact ? `<div style="font-size:12.5px;color:#6B7280;margin-top:2px;">${esc(contact)}</div>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;">${chips.map(chipHtml).join('')}</div>
      </div>
      <div class="sac-detail-actions">${actions}</div>
    </div>
    <div class="sac-section"><div class="sac-section-title">Details</div><div>${detailsSection(d)}</div></div>
    <div class="sac-section"><div class="sac-section-title">Notes</div><div>${notesSection(d, write)}</div></div>
    <div class="sac-section"><div class="sac-section-title">Stage History</div><div>${historySection(d, write)}</div></div>
    <div class="sac-section"><div class="sac-section-title">Follow-up Reminders</div><div>${followupsSection(d, write)}</div></div>`;
}

// Read-only person details (address, DOB/age, school, parents + awareness,
// spiritual director, gender).
function detailsSection(d) {
  const row = (label, val) => val ? `<div style="display:flex;gap:10px;font-size:13px;padding:3px 0;"><span style="color:#6B7280;min-width:150px;">${esc(label)}</span><span style="flex:1;color:var(--navy);">${val}</span></div>` : '';
  const addr = [d.street, [d.city, d.state].filter(Boolean).join(', '), d.zip].filter(Boolean).join(' · ');
  const school = [d.school_name, [d.school_city, d.school_state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const age = ageOf(d.dob);
  const parents = parentsOf(d).map(p => {
    const nm = [p.first, p.last].filter(Boolean).join(' ');
    const ct = [p.phone, p.email].filter(Boolean).join(' · ');
    return `<div>${esc(nm || 'Parent')}${ct ? ` — ${esc(ct)}` : ''}</div>`;
  }).join('');
  const awareness = d.parent_aware == null ? '' :
    (d.parent_aware ? `<span style="color:#2D6A4F;">Parent aware of discernment</span>` : `<span style="color:#9A6A1E;">Parent <strong>UNAWARE</strong> of discernment</span>`);
  const out = [
    row('Gender', d.gender ? (d.gender === 'male' ? 'Male' : 'Female') : ''),
    row('Date of birth', d.dob ? `${esc(formatDateDisplay(d.dob))}${age !== null ? ` (age ${age})` : ''}` : ''),
    row('Mailing address', addr ? esc(addr) : ''),
    row('School', school ? esc(school) : ''),
    row('Parent contact', parents),
    row('Parent awareness', awareness),
    row('Spiritual director', d.spiritual_director ? esc(d.spiritual_director) : ''),
  ].filter(Boolean).join('');
  return out || '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No details recorded.</div>';
}

function notesSection(d, write) {
  const list = notesOf(d);
  const body = list.length
    ? `<div class="sac-tl">${list.map(n => `<div class="sac-tl-entry">
        <div class="sac-tl-row"><span class="sac-tl-text" style="white-space:pre-wrap;">${n.subject ? `<strong>${esc(n.subject)}</strong> — ` : ''}${esc(n.body || '')}</span>${write ? `<button class="sac-tl-x" title="Edit" data-act="edit-note" data-id="${n.id}" style="font-size:12px;">✎</button><button class="sac-tl-x" title="Delete" data-act="del-note" data-id="${n.id}">×</button>` : ''}</div>
        <div class="sac-tl-time">${esc(formatDateDisplay(n.note_date || (n.created_at || '').slice(0, 10)))}${n.author_id ? ' · ' + esc(userName(n.author_id)) : ''}${noteEditedMarker(n.edited_at)}</div>
      </div>`).join('')}</div>`
    : '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No notes yet.</div>';
  if (!write) return body;
  return body + `<div class="sac-add-block">
    <div class="sac-add-head">Add Note</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
      <input type="text" id="disc-note-subject" placeholder="Subject (optional)" style="flex:1;min-width:120px;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
      <input type="date" id="disc-note-date" value="${todayCST()}" style="box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .5rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
    </div>
    <div style="display:flex;gap:6px;align-items:flex-start;margin-top:6px;">
      <textarea id="disc-note-body" rows="2" placeholder="Write a note…" style="flex:1;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;resize:vertical;"></textarea>
      <button class="btn-secondary" style="padding:.4rem .9rem;font-size:12px;white-space:nowrap;" data-act="add-note" data-id="${d.id}">+ Add</button>
    </div>
  </div>`;
}

function historySection(d, write) {
  const list = historyOf(d);
  if (!list.length) return '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No stage history yet.</div>';
  return `<div class="sac-tl">${list.map(t => `<div class="sac-tl-entry">
    <div class="sac-tl-row"><span class="sac-tl-text">${t.from_stage ? `${esc(t.from_stage)} → ` : 'Started at '}<strong>${esc(t.to_stage)}</strong></span>${write ? `<button class="sac-tl-x" title="Delete this transition" data-act="del-transition" data-id="${t.id}">×</button>` : ''}</div>
    <div class="sac-tl-time">${esc(formatDateDisplay((t.transitioned_at || '').slice(0, 10)))}${t.transitioned_by ? ' · ' + esc(userName(t.transitioned_by)) : ''}${t.note ? ' · ' + esc(t.note) : ''}</div>
  </div>`).join('')}</div>`;
}

function followupsSection(d, write) {
  const list = followupsOf(d);
  const today = todayCST();
  const body = list.length
    ? `<div style="display:flex;flex-direction:column;gap:6px;">${list.map(f => {
        const over = !f.done && isOverdue(f.due_date, today);
        return `<div class="disc-fu-item" style="display:flex;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:.5px solid #F0EDE8;">
          <input type="checkbox" ${f.done ? 'checked' : ''} ${write ? '' : 'disabled'} data-act="toggle-followup" data-id="${f.id}" style="width:15px;height:15px;accent-color:var(--cardinal);margin-top:2px;flex-shrink:0;${write ? 'cursor:pointer;' : ''}" />
          <div style="flex:1;min-width:0;">
            <div class="sac-tl-row">
              <span class="sac-tl-text" style="${f.done ? 'text-decoration:line-through;opacity:.6;' : ''}">${esc(f.note || 'Follow up')}</span>
              ${write ? `<button class="sac-tl-x" title="Delete" data-act="del-followup" data-id="${f.id}">×</button>` : ''}
            </div>
            <div style="font-size:11.5px;color:${over ? 'var(--cardinal)' : '#9CA3AF'};font-weight:${over ? '600' : '400'};">${f.due_date ? esc(formatDateDisplay(f.due_date)) : 'No date'}${over ? ' · overdue' : ''}${f.done && f.done_at ? ' · done ' + esc(formatDateDisplay((f.done_at || '').slice(0, 10))) : ''}</div>
          </div>
        </div>`; }).join('')}</div>`
    : '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No follow-ups scheduled.</div>';
  if (!write) return body;
  return body + `<div class="sac-add-block">
    <div class="sac-add-head">Add Follow-up</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
      <input type="date" id="disc-fu-date" value="${todayCST()}" style="box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .5rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" />
      <input type="text" id="disc-fu-note" placeholder="What to follow up on…" style="flex:1;min-width:140px;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;background:#fff;" onkeydown="if(event.key==='Enter'){event.preventDefault();window.discAddFollowup('${d.id}');}" />
      <button class="btn-secondary" style="padding:.4rem .9rem;font-size:12px;white-space:nowrap;" data-act="add-followup" data-id="${d.id}">+ Add</button>
    </div>
  </div>`;
}

// ── Grantee header (axis 2) — consumes the % layer. Shown only when the current
// viewer sees this file via a grant (not creator / super-admin / panel access).
async function fillGranteeHeader(d) {
  const host = document.getElementById('disc-grantee');
  if (!host) return;
  if (isSuperAdmin() || _isCreator(d) || canAccessDiscernment()) return;   // not a grant-only viewer
  const grant = await fetchGrantRow('discerner', d.id, _authUserId);
  if (!grant) return;
  await ensureIdentities().catch(() => {});
  const granter = grant.granted_by ? userName(grant.granted_by) : 'an administrator';
  host.innerHTML = `<div style="background:#EEEAF6;border:.5px solid #D6CDEC;border-radius:6px;padding:.5rem .7rem;margin-bottom:.85rem;font-size:12px;color:#4A3D74;">
    <i class="fa-solid fa-key" style="margin-right:5px;"></i><strong>Access granted by ${esc(granter)}</strong>${grant.note ? ` — ${esc(grant.note)}` : ''}
    <div style="font-size:10.5px;color:#7A6BA6;margin-top:2px;">This file is not yours — you are viewing it read-only under a specific grant.</div>
  </div>`;
}

// ── Event delegation ─────────────────────────────────────────────────────────
function onShellInput(e) {
  // Search re-renders ONLY the card body so the input keeps focus mid-typing.
  if (e.target?.id === 'disc-search') { _search = e.target.value; renderListBody(); }
}
function onShellChange(e) {
  if (e.target?.id === 'disc-stage-filter') { _stageFilter = e.target.value; renderListBody(); }
}
function renderListBody() {
  const scroll = root()?.querySelector('.sac-list-scroll');
  if (scroll) scroll.innerHTML = listBodyHtml();
}
function renderListOnly() {
  const list = root()?.querySelector('.sac-list');
  if (list) list.innerHTML = listHtml();   // full head re-render (filter pills active-state)
}
async function onShellClick(e) {
  const t = e.target.closest('[data-act]'); if (!t) return;
  const act = t.dataset.act, id = t.dataset.id;
  switch (act) {
    case 'voc': _vocFilter = t.dataset.key; renderListOnly(); break;
    case 'toggle-archived': _showArchived = !_showArchived; renderListOnly(); break;
    case 'open': selectDiscerner(id); break;
    case 'back': selectDiscerner(null); break;
    case 'new': openIntake(); break;
    case 'edit': openIntake(selected()); break;
    case 'move-stage': openMoveStage(selected()); break;
    case 'toggle-archive': await toggleArchive(selected()); break;
    case 'delete': await deleteDiscerner(selected()); break;
    case 'toggle-pin': await togglePin(id); break;
    case 'add-note': await addNote(id); break;
    case 'edit-note': await editNote(id); break;
    case 'del-note': await deleteNote(id); break;
    case 'del-transition': await deleteTransition(id); break;
    case 'add-followup': await addFollowup(id); break;
    case 'toggle-followup': e.stopPropagation(); await toggleFollowup(id, t.checked); break;
    case 'del-followup': await deleteFollowup(id); break;
  }
}

// ── Writes (retry-wrapped) ─────────────────────────────────────────────────
async function addNote(discernerId) {
  const d = selected(); if (!d || !canWriteDiscerner(d)) return;
  const body = (document.getElementById('disc-note-body')?.value || '').trim();
  const subject = (document.getElementById('disc-note-subject')?.value || '').trim() || null;
  const noteDate = document.getElementById('disc-note-date')?.value || todayCST();
  if (!body) return;
  const { data, error } = await insertWithRetry('discernment_notes', {
    discerner_id: discernerId, parish_id: d.parish_id, author_id: _authUserId,
    note_date: noteDate, subject, body,
  }, { select: '*' });
  if (error) { reportWriteError('discernment note', error); return; }
  (_notesByD[discernerId] = _notesByD[discernerId] || []).push(data);
  logActivity({ action: 'added discernment note', entityType: 'discerner', entityName: discernerName(d), contextType: 'discernment', contextId: discernerId });
  window.flashSavedThen(() => render());
}
async function editNote(noteId) {
  const d = selected(); if (!d || !canWriteDiscerner(d)) return;
  const n = (_notesByD[d.id] || []).find(x => x.id === noteId); if (!n) return;
  const text = promptNoteEdit(n.body);
  if (text === null) return;   // cancelled / unchanged
  const patch = { body: text, edited_at: nowIso() };
  const { error } = await withWriteRetry(() => sb.from('discernment_notes').update(patch).eq('id', noteId), { kind: 'update' });
  if (error) { reportWriteError('discernment note edit', error); return; }
  Object.assign(n, patch);
  window.flashSavedThen(() => render());
}
async function deleteNote(noteId) {
  const d = selected(); if (!d || !canWriteDiscerner(d)) return;
  const { error } = await deleteWithRetry(() => sb.from('discernment_notes').delete().eq('id', noteId));
  if (error) { reportWriteError('discernment note delete', error); return; }
  _notesByD[d.id] = (_notesByD[d.id] || []).filter(n => n.id !== noteId);
  render();
}
// Per-user pin / unpin (writes discernment_pins; only this user sees their pins).
async function togglePin(discernerId) {
  const d = _discerners.find(x => x.id === discernerId); if (!d) return;
  if (_pins.has(discernerId)) {
    const { error } = await deleteWithRetry(() => sb.from('discernment_pins').delete().eq('user_id', _authUserId).eq('discerner_id', discernerId));
    if (error) { reportWriteError('discernment unpin', error); return; }
    _pins.delete(discernerId);
  } else {
    const { error } = await insertWithRetry('discernment_pins', { user_id: _authUserId, discerner_id: discernerId, parish_id: d.parish_id });
    if (error) { reportWriteError('discernment pin', error); return; }
    _pins.add(discernerId);
  }
  renderListBody();   // re-order the card column (pinned float to top)
}
async function addFollowup(discernerId) {
  const d = selected(); if (!d || !canWriteDiscerner(d)) return;
  const due = document.getElementById('disc-fu-date')?.value || null;
  const note = (document.getElementById('disc-fu-note')?.value || '').trim() || null;
  if (!due && !note) return;
  const { data, error } = await insertWithRetry('discernment_followups', {
    discerner_id: discernerId, parish_id: d.parish_id, created_by: _authUserId,
    due_date: due, note, done: false,
  }, { select: '*' });
  if (error) { reportWriteError('discernment follow-up', error); return; }
  (_followByD[discernerId] = _followByD[discernerId] || []).push(data);
  logActivity({ action: 'added discernment follow-up', entityType: 'discerner', entityName: discernerName(d), contextType: 'discernment', contextId: discernerId });
  window.flashSavedThen(() => render());
}
async function toggleFollowup(followupId, done) {
  const d = selected(); if (!d || !canWriteDiscerner(d)) return;
  const f = (_followByD[d.id] || []).find(x => x.id === followupId); if (!f) return;
  const patch = { done: !!done, done_at: done ? nowIso() : null };
  const { error } = await serializeWrite(`disc-fu:${followupId}`, () =>
    withWriteRetry(() => sb.from('discernment_followups').update(patch).eq('id', followupId), { kind: 'update' }));
  if (error) { reportWriteError('discernment follow-up toggle', error); return; }
  Object.assign(f, patch);
  render();
}
async function deleteFollowup(followupId) {
  const d = selected(); if (!d || !canWriteDiscerner(d)) return;
  const { error } = await deleteWithRetry(() => sb.from('discernment_followups').delete().eq('id', followupId));
  if (error) { reportWriteError('discernment follow-up delete', error); return; }
  _followByD[d.id] = (_followByD[d.id] || []).filter(x => x.id !== followupId);
  render();
}
// Delete a stage transition (non-destructive to the rest of history; the current
// stage simply re-derives from whatever transitions remain).
async function deleteTransition(transitionId) {
  const d = selected(); if (!d || !canWriteDiscerner(d)) return;
  if (!confirm('Delete this stage transition? The current stage will re-derive from the remaining history.')) return;
  const { error } = await deleteWithRetry(() => sb.from('discernment_stage_transitions').delete().eq('id', transitionId));
  if (error) { reportWriteError('discernment transition delete', error); return; }
  _transByD[d.id] = (_transByD[d.id] || []).filter(x => x.id !== transitionId);
  logActivity({ action: 'deleted discernment stage transition', entityType: 'discerner', entityName: discernerName(d), contextType: 'discernment', contextId: d.id });
  render();
}
// Permanently delete the whole discerner file (child notes/transitions/follow-ups
// cascade via FK ON DELETE CASCADE). Routed through the shared deleteWithRetry.
async function deleteDiscerner(d) {
  if (!d || !canWriteDiscerner(d)) return;
  if (!confirm(`Permanently delete the discernment file for ${discernerName(d)}? This removes all notes, stage history, and follow-ups. This cannot be undone.`)) return;
  const { error } = await deleteWithRetry(() => sb.from('discerners').delete().eq('id', d.id));
  if (error) { reportWriteError('discernment delete', error); return; }
  _discerners = _discerners.filter(x => x.id !== d.id);
  delete _notesByD[d.id]; delete _transByD[d.id]; delete _followByD[d.id];
  logActivity({ action: 'deleted discernment file', entityType: 'discerner', entityName: discernerName(d), contextType: 'discernment', contextId: d.id });
  selectDiscerner(null);   // back to the list
  render();
}
async function toggleArchive(d) {
  if (!d || !canWriteDiscerner(d)) return;
  const archived = isArchived(d);
  if (!archived && !confirm('Archive this discernment file? It will be hidden from the default list (a discerner concluding does NOT revoke any %-granted access — manage that in the Admin audit view).')) return;
  const patch = { archived_at: archived ? null : nowIso(), updated_at: nowIso() };
  const { error } = await withWriteRetry(() => sb.from('discerners').update(patch).eq('id', d.id), { kind: 'update' });
  if (error) { reportWriteError('discernment archive', error); return; }
  Object.assign(d, patch);
  logActivity({ action: archived ? 'unarchived discernment file' : 'archived discernment file', entityType: 'discerner', entityName: discernerName(d), contextType: 'discernment', contextId: d.id });
  render();
}

// ── Move-stage modal (writes a frozen transition) ────────────────────────────
function openMoveStage(d) {
  if (!d || !canWriteDiscerner(d)) return;
  const cur = currentStageOf(d);
  const opts = ALL_STAGES.map(s => `<option value="${esc(s)}"${s === cur ? ' selected' : ''}>${esc(s)}${s === cur ? ' (current)' : ''}</option>`).join('');
  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">Move stage</div>
    <div style="font-size:13px;color:var(--navy);font-weight:600;margin-bottom:.6rem;">${esc(discernerName(d))}</div>
    <div style="font-size:12px;color:#6B7280;margin-bottom:.6rem;">Current stage: <strong>${esc(cur || 'none yet')}</strong></div>
    <label>New stage</label>
    <select id="disc-ms-stage">${opts}</select>
    <label>Date</label>
    <input type="date" id="disc-ms-date" value="${todayCST()}" />
    <label>Note (optional)</label>
    <textarea id="disc-ms-note" rows="2" placeholder="Why the change…"></textarea>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="disc-ms-confirm">Record transition</button>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('disc-ms-confirm').addEventListener('click', () => confirmMoveStage(d));
}
async function confirmMoveStage(d) {
  const to = document.getElementById('disc-ms-stage')?.value;
  const note = (document.getElementById('disc-ms-note')?.value || '').trim() || null;
  const dateVal = document.getElementById('disc-ms-date')?.value;
  if (!to) return;
  const from = currentStageOf(d);
  if (to === from && !note) { window.closeModal(); return; }      // no-op
  const transitioned_at = dateVal ? new Date(dateVal + 'T12:00:00').toISOString() : nowIso();
  const { data, error } = await insertWithRetry('discernment_stage_transitions', {
    discerner_id: d.id, parish_id: d.parish_id, from_stage: from, to_stage: to,
    transitioned_at, transitioned_by: _authUserId, note,
  }, { select: '*' });
  if (error) { reportWriteError('discernment transition', error); return; }
  (_transByD[d.id] = _transByD[d.id] || []).push(data);
  logActivity({ action: `moved discernment stage to ${to}`, entityType: 'discerner', entityName: discernerName(d), contextType: 'discernment', contextId: d.id });
  window.flashSavedThen(() => { window.closeModal(); render(); });
}

// ── Intake modal (create / edit) — INLINE person model only ─────────────────
function openIntake(d = null) {
  if (d ? !canWriteDiscerner(d) : !canCreate()) return;
  const isEdit = !!d;
  const np = nameParts(d || {});
  _M = {
    id: d?.id || null, isEdit,
    gender: d?.gender || null,
    parents: parentsOf(d || {}).map(p => ({ first: p.first || '', last: p.last || '', phone: p.phone || '', email: p.email || '' })),
  };
  if (!_M.parents.length) _M.parents = [{ first: '', last: '', phone: '', email: '' }];

  const vocOpts = Object.entries(VOCATION_TYPES).map(([k, l]) =>
    `<option value="${k}"${d?.vocation_type === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const stageOpts = [...STAGE_LADDER, ...TERMINAL_STAGES].map(s =>
    `<option value="${esc(s)}"${s === STARTING_STAGE ? ' selected' : ''}>${esc(s)}</option>`).join('');
  const school = institutionOptionsHtml(d?.school_name || '');
  const dob = (d?.dob && /^\d{4}-\d{2}-\d{2}/.test(d.dob)) ? d.dob.slice(0, 10) : '';
  const head = (t) => `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--cardinal);margin:1rem 0 .4rem;">${t}</div>`;

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">${isEdit ? 'Edit discernment file' : 'New discernment file'}</div>

    <label>Name</label>
    <div style="display:flex;gap:8px;">
      <div style="flex:1;"><input type="text" id="disc-first" placeholder="First" value="${esc(np.first)}" /></div>
      <div style="flex:1;"><input type="text" id="disc-middle" placeholder="Middle" value="${esc(np.middle)}" /></div>
      <div style="flex:1;"><input type="text" id="disc-last" placeholder="Last" value="${esc(np.last)}" /></div>
    </div>

    <label>Gender</label>
    <div style="display:flex;gap:8px;">
      <button type="button" class="cf-btn" id="disc-gender-male" onclick="discSetGender('male')" style="flex:1;">Male</button>
      <button type="button" class="cf-btn" id="disc-gender-female" onclick="discSetGender('female')" style="flex:1;">Female</button>
    </div>

    <label style="margin-top:.75rem;">Vocation type</label>
    <select id="disc-voc">${vocOpts}</select>
    ${isEdit ? '' : `<label>Starting stage</label><select id="disc-start-stage">${stageOpts}</select>`}

    <label>Date of birth</label>
    <input type="date" id="disc-dob" value="${esc(dob)}" />

    ${head('Mailing Address')}
    <label>Street</label><input type="text" id="disc-street" value="${esc(d?.street || '')}" />
    <div style="display:flex;gap:8px;">
      <div style="flex:2;"><label>City</label><input type="text" id="disc-city" value="${esc(d?.city || '')}" /></div>
      <div style="flex:1;"><label>State</label>${_stateSelect('disc-state', d?.state || '')}</div>
      <div style="flex:1;"><label>Zip</label><input type="text" id="disc-zip" value="${esc(d?.zip || '')}" /></div>
    </div>

    <div style="display:flex;gap:8px;">
      <div style="flex:1;"><label>Cell phone</label><input type="tel" id="disc-phone" value="${esc(d?.phone || '')}" /></div>
      <div style="flex:1;"><label>Email</label><input type="email" id="disc-email" value="${esc(d?.email || '')}" /></div>
    </div>

    <label style="margin-top:.75rem;">School</label>
    <select id="disc-school-sel" onchange="discSchoolChange(this.value)"><option value="">— Select —</option>${school.options}<option value="__other"${school.isOther ? ' selected' : ''}>Other…</option></select>
    <div id="disc-school-other-wrap" style="display:${school.isOther ? 'block' : 'none'};margin-top:6px;"><label>School name</label><input type="text" id="disc-school-name" value="${esc(school.isOther ? (d?.school_name || '') : '')}" /></div>
    <div style="display:flex;gap:8px;">
      <div style="flex:2;"><label>School city</label><input type="text" id="disc-school-city" value="${esc(d?.school_city || '')}" /></div>
      <div style="flex:1;"><label>School state</label>${_stateSelect('disc-school-state', d?.school_state || '')}</div>
    </div>

    ${head('Parent / Guardian')}
    <div id="disc-parents"></div>
    <label style="display:inline-flex;align-items:center;gap:8px;margin-top:.6rem;cursor:pointer;">
      <input type="checkbox" id="disc-parent-aware" ${d?.parent_aware ? 'checked' : ''} style="width:15px;height:15px;accent-color:var(--cardinal);" /> Parent aware of discernment?
    </label>

    <div style="margin-top:.75rem;">${buildOfficiantField('disc-spirdir', d?.spiritual_director || '', { label: 'Spiritual Director' })}</div>

    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="disc-intake-save">${isEdit ? 'Save' : 'Create file'}</button>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');
  document.getElementById('disc-intake-save').addEventListener('click', () => saveIntake());
  renderParents();
  syncGenderButtons();
  institutionAddressSync('disc-school-sel', { city: 'disc-school-city', state: 'disc-school-state' });
}
// Gender — mutually exclusive; clicking the active one clears it.
function discSetGender(g) { _M.gender = (_M.gender === g) ? null : g; syncGenderButtons(); }
function syncGenderButtons() {
  document.getElementById('disc-gender-male')?.classList.toggle('active', _M.gender === 'male');
  document.getElementById('disc-gender-female')?.classList.toggle('active', _M.gender === 'female');
}
// School dropdown change — toggle the "Other" name input + autofill/grey City/State.
function discSchoolChange(v) {
  const wrap = document.getElementById('disc-school-other-wrap'); if (wrap) wrap.style.display = v === '__other' ? 'block' : 'none';
  institutionAddressAutofill(v, { city: 'disc-school-city', state: 'disc-school-state' });
}
// Parent contacts (1–2 repeatable set).
function renderParents() {
  const el = document.getElementById('disc-parents'); if (!el) return;
  el.innerHTML = _M.parents.map((p, i) => `
    <div style="background:var(--parch);border:.5px solid var(--stone);border-radius:var(--radius-sm);padding:.6rem;margin-bottom:.5rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><span style="font-size:12px;font-weight:600;color:#555;">Parent ${i + 1}</span>${_M.parents.length > 1 ? `<button type="button" onclick="discRemoveParent(${i})" style="background:none;border:none;cursor:pointer;color:#CCC;font-size:12px;" onmouseover="this.style.color='#E74C3C'" onmouseout="this.style.color='#CCC'">× Remove</button>` : ''}</div>
      <div style="display:flex;gap:8px;"><div style="flex:1;"><label>First name</label><input type="text" id="disc-par-first-${i}" value="${esc(p.first)}" /></div><div style="flex:1;"><label>Last name</label><input type="text" id="disc-par-last-${i}" value="${esc(p.last)}" /></div></div>
      <div style="display:flex;gap:8px;"><div style="flex:1;"><label>Cell phone</label><input type="tel" id="disc-par-phone-${i}" value="${esc(p.phone)}" /></div><div style="flex:1;"><label>Email</label><input type="email" id="disc-par-email-${i}" value="${esc(p.email)}" /></div></div>
    </div>`).join('')
    + (_M.parents.length < 2 ? `<button type="button" class="btn-secondary" style="padding:.3rem .8rem;font-size:12px;" onclick="discAddParent()">+ Add second parent</button>` : '');
}
function _syncParents() {
  _M.parents = _M.parents.map((p, i) => ({
    first: document.getElementById(`disc-par-first-${i}`)?.value.trim() || '',
    last: document.getElementById(`disc-par-last-${i}`)?.value.trim() || '',
    phone: document.getElementById(`disc-par-phone-${i}`)?.value.trim() || '',
    email: document.getElementById(`disc-par-email-${i}`)?.value.trim() || '',
  }));
}
function discAddParent() { _syncParents(); if (_M.parents.length < 2) _M.parents.push({ first: '', last: '', phone: '', email: '' }); renderParents(); }
function discRemoveParent(i) { _syncParents(); _M.parents.splice(i, 1); if (!_M.parents.length) _M.parents = [{ first: '', last: '', phone: '', email: '' }]; renderParents(); }

async function saveIntake() {
  const voc = document.getElementById('disc-voc')?.value;
  if (!voc) { alert('Vocation type is required.'); return; }
  const gv = (id) => (document.getElementById(id)?.value || '').trim();
  const first = gv('disc-first'), middle = gv('disc-middle'), last = gv('disc-last');
  const name = [first, middle, last].filter(Boolean).join(' ');
  if (!name) { alert('A first or last name is required.'); return; }
  _syncParents();
  const parents = _M.parents.filter(p => p.first || p.last || p.phone || p.email);
  // `name` stays the denormalized combined value (card + % grantable search read it).
  const fields = {
    first_name: first || null, middle_name: middle || null, last_name: last || null, name,
    gender: _M.gender || null,
    dob: gv('disc-dob') || null,
    street: gv('disc-street') || null, city: gv('disc-city') || null, state: gv('disc-state') || null, zip: gv('disc-zip') || null,
    phone: gv('disc-phone') || null, email: gv('disc-email') || null,
    school_name: institutionSelectedName(document.getElementById('disc-school-sel')?.value, 'disc-school-name'),
    school_city: gv('disc-school-city') || null, school_state: gv('disc-school-state') || null,
    parents,
    parent_aware: !!document.getElementById('disc-parent-aware')?.checked,
    spiritual_director: readOfficiantValue('disc-spirdir'),
    vocation_type: voc,
    updated_at: nowIso(),
  };

  if (_M.isEdit) {
    const d = _discerners.find(x => x.id === _M.id); if (!d) return;
    const { error } = await withWriteRetry(() => sb.from('discerners').update(fields).eq('id', d.id), { kind: 'update' });
    if (error) { reportWriteError('discernment update', error); return; }
    Object.assign(d, fields);
    logActivity({ action: 'updated discernment file', entityType: 'discerner', entityName: name, contextType: 'discernment', contextId: d.id });
    window.flashSavedThen(() => { _cleanupIntake(); render(); });
    return;
  }

  // Create: insert the file, then write the FIRST transition (NULL → starting stage).
  // Omit parish_id when unknown so the DB default current_parish_id() applies.
  const parishId = store.parishSettings?.id || undefined;
  const startStage = document.getElementById('disc-start-stage')?.value || STARTING_STAGE;
  const { data, error } = await insertWithRetry('discerners', { ...fields, parish_id: parishId, author_id: _authUserId }, { select: '*' });
  if (error) { reportWriteError('discernment create', error); return; }
  _discerners.unshift(data);
  const { data: tr } = await insertWithRetry('discernment_stage_transitions', {
    discerner_id: data.id, parish_id: data.parish_id, from_stage: null, to_stage: startStage,
    transitioned_at: nowIso(), transitioned_by: _authUserId,
  }, { select: '*' });
  if (tr) (_transByD[data.id] = _transByD[data.id] || []).push(tr);
  logActivity({ action: 'created discernment file', entityType: 'discerner', entityName: name, contextType: 'discernment', contextId: data.id });
  window.flashSavedThen(() => { _cleanupIntake(); selectDiscerner(data.id); render(); });
}
function _cleanupIntake() { _M = null; window.closeModal(); }

// ── Globals (HTML onclick + cross-link entry) ────────────────────────────────
Object.assign(window, {
  expandDiscerner,
  discAddFollowup: (id) => addFollowup(id),
  discSetGender, discSchoolChange, discAddParent, discRemoveParent,
});

// ─────────────────────────────────────────────────────────────────────────────
// SHELL-REUSE DECISION: this panel does NOT call renderSacramentalPanel; it is a
// Discernment-specific master-detail that REUSES the shell's CSS classes
// (.sac-shell/.sac-list/.sac-item/.sac-detail/.sac-section/.sac-tl/.sac-add-block/
// .cf-btn/.badge/.sac-avatar/.sac-detail-btn) + chipHtml + design tokens, so it
// is visually unified with the sacramental panels. A dedicated renderer was
// chosen because three shell assumptions don't fit cleanly: (1) the shell's
// statusFilters is a SINGLE mutually-exclusive pill axis, but Discernment needs
// TWO independent filters (stage + vocation type); (2) the header needs a
// move-stage control that writes a transition + an archive toggle, beyond the
// shell's generic action buttons; (3) %-grantee READ-ONLY gating must apply
// per-file (creator/super/panel write; grantee read-only) with the grantee
// header, which the shell's global canManage() does not express.
