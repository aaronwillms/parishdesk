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

import { sb, withWriteRetry, serializeWrite, insertWithRetry } from '../supabase.js';
import { store } from '../store.js';
import { logActivity, reportWriteError, todayCST, formatDateDisplay, daysUntil } from '../utils.js';
import { isSuperAdmin, canAccessDiscernment } from '../roles.js';
import { chipHtml } from '../sacramental/panelShell.js';
import { createContactPicker } from '../ui/contactPicker.js';
import { ensureIdentities, userName, fetchGrantRow, loadMyGrants, hasMyGrantForLink } from '../ui/grants.js';
import {
  ALL_STAGES, STAGE_LADDER, TERMINAL_STAGES, STARTING_STAGE, stageChipStyle, stageRank,
  VOCATION_TYPES, vocationLabel, currentStage as deriveStage, nextFollowup as deriveNextFollowup,
  isOverdue, canViewDiscernerCore, canWriteDiscernerCore,
} from '../discernment/derive.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── Module state ─────────────────────────────────────────────────────────────
let _discerners = [];
let _notesByD = {}, _transByD = {}, _followByD = {};
let _authUserId = null;
let _selectedId = null;
let _stageFilter = 'all', _vocFilter = 'all', _search = '', _showArchived = false;
let _M = null;          // create/edit modal state
let _picker = null;     // contact picker instance (link-existing intake)
let _hashBound = false;

const nowIso = () => new Date().toISOString();

// ── Person model — name/contact DERIVE from the linked directory person when
// person_id is set; otherwise the inline identity fields on the file are used.
function discernerName(d) {
  if (d.person_id) {
    const p = (store.personnel || []).find(x => x.id === d.person_id);
    if (p?.name) return p.name;
  }
  return d.name || 'Unnamed discerner';
}
function discernerContact(d) {
  // Inline contact lives on the file; for a linked person we still show whatever
  // inline contact was captured (the directory person carries no email/phone here).
  return [d.phone || '', d.email || ''].filter(Boolean).join(' · ');
}
function isArchived(d) { return !!d.archived_at; }

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
  return transitionsOf(d.id).slice().sort((a, b) =>
    String(b.transitioned_at || '').localeCompare(String(a.transitioned_at || '')));  // newest first
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
    el.innerHTML = `<div class="sac-shell" id="disc-shell"></div>`;
    shell = el.querySelector('#disc-shell');
    shell.addEventListener('click', onShellClick);
    shell.addEventListener('input', onShellInput);
    shell.addEventListener('change', onShellChange);
  }
  shell.classList.toggle('detail-open', !!_selectedId);
  shell.innerHTML = `<div class="sac-list">${listHtml()}</div><div class="sac-detail">${detailHtml()}</div>`;
  // Grantee header (axis 2) is async — fill it after the sync paint.
  const d = selected();
  if (d) fillGranteeHeader(d);
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
  }).sort((a, b) => {
    if (isArchived(a) !== isArchived(b)) return isArchived(a) ? 1 : -1;          // archived last
    const ra = stageRank(currentStageOf(a)), rb = stageRank(currentStageOf(b));
    if (ra !== rb) return ra - rb;                                                // by ladder progress
    return discernerName(a).localeCompare(discernerName(b));
  });
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
  const rows = visibleDiscerners();
  return rows.length
    ? rows.map(cardHtml).join('')
    : `<div style="font-size:13px;color:#6B7280;padding:.5rem;">${_discerners.length ? 'No discerners match.' : 'No discernment files yet.'}</div>`;
}

function cardHtml(d) {
  const sel = _selectedId === d.id;
  const stage = currentStageOf(d);
  const chips = [{ label: vocationLabel(d.vocation_type), tone: 'neutral' }];
  if (stage) chips.push({ label: stage, tone: 'neutral', style: stageChipStyle(stage) });
  if (isArchived(d)) chips.push({ label: 'Archived', tone: 'neutral', style: 'background:#F2F3F4;color:#616A6B;' });
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
  return `<div class="sac-item${sel ? ' selected' : ''}" data-act="open" data-id="${d.id}">
    <div class="sac-item-row"><div style="flex:1;min-width:0;">
      <div class="sac-item-title">${esc(discernerName(d))}</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-top:5px;">${chips.map(chipHtml).join('')}</div>
      ${next}
    </div></div>
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
  const chips = [{ label: vocationLabel(d.vocation_type), tone: 'neutral' }];
  if (stage) chips.push({ label: stage, tone: 'neutral', style: stageChipStyle(stage) });
  if (isArchived(d)) chips.push({ label: 'Archived', tone: 'neutral', style: 'background:#F2F3F4;color:#616A6B;' });
  const contact = discernerContact(d);
  const initials = (discernerName(d).match(/\b\w/g) || ['?']).slice(0, 2).join('').toUpperCase();

  const actions = write ? `
    <button class="btn-secondary sac-detail-btn" data-act="move-stage" aria-label="Move stage"><i class="fa-solid fa-arrow-right-arrow-left"></i> <span class="sac-btn-label">Move stage</span></button>
    <button class="btn-secondary sac-detail-btn" data-act="toggle-archive" aria-label="${isArchived(d) ? 'Unarchive' : 'Archive'}"><i class="fa-solid fa-box-archive"></i> <span class="sac-btn-label">${isArchived(d) ? 'Unarchive' : 'Archive'}</span></button>
    <button class="btn-primary sac-detail-btn" data-act="edit" aria-label="Edit"><i class="fa-solid fa-pencil"></i> <span class="sac-btn-label">Edit</span></button>` : '';

  return `
    <div id="disc-grantee"></div>
    <div class="sac-detail-head">
      <button class="sac-back" data-act="back" aria-label="Back">‹</button>
      <div class="sac-avatar">${esc(initials)}</div>
      <div class="sac-detail-main">
        <div class="sac-detail-name">${esc(discernerName(d))}</div>
        ${contact ? `<div style="font-size:12.5px;color:#6B7280;margin-top:2px;">${esc(contact)}</div>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;">${chips.map(chipHtml).join('')}</div>
      </div>
      <div class="sac-detail-actions">${actions}</div>
    </div>
    <div class="sac-section"><div class="sac-section-title">Notes</div><div>${notesSection(d, write)}</div></div>
    <div class="sac-section"><div class="sac-section-title">Stage History</div><div>${historySection(d)}</div></div>
    <div class="sac-section"><div class="sac-section-title">Follow-up Reminders</div><div>${followupsSection(d, write)}</div></div>`;
}

function notesSection(d, write) {
  const list = notesOf(d);
  const body = list.length
    ? `<div class="sac-tl">${list.map(n => `<div class="sac-tl-entry">
        <div class="sac-tl-row"><span class="sac-tl-text" style="white-space:pre-wrap;">${n.subject ? `<strong>${esc(n.subject)}</strong> — ` : ''}${esc(n.body || '')}</span>${write ? `<button class="sac-tl-x" title="Delete" data-act="del-note" data-id="${n.id}">×</button>` : ''}</div>
        <div class="sac-tl-time">${esc(formatDateDisplay(n.note_date || (n.created_at || '').slice(0, 10)))}${n.author_id ? ' · ' + esc(userName(n.author_id)) : ''}</div>
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

function historySection(d) {
  const list = historyOf(d);
  if (!list.length) return '<div style="font-size:13px;color:#9CA3AF;font-style:italic;">No stage history yet.</div>';
  return `<div class="sac-tl">${list.map(t => `<div class="sac-tl-entry">
    <div class="sac-tl-row"><span class="sac-tl-text">${t.from_stage ? `${esc(t.from_stage)} → ` : 'Started at '}<strong>${esc(t.to_stage)}</strong></span></div>
    <div class="sac-tl-time">${esc(formatDateDisplay((t.transitioned_at || '').slice(0, 10)))}${t.transitioned_by ? ' · ' + esc(userName(t.transitioned_by)) : ''}${t.note ? ' · ' + esc(t.note) : ''}</div>
  </div>`).join('')}</div>`;
}

function followupsSection(d, write) {
  const list = followupsOf(d);
  const today = todayCST();
  const body = list.length
    ? `<div style="display:flex;flex-direction:column;gap:6px;">${list.map(f => {
        const over = !f.done && isOverdue(f.due_date, today);
        return `<div style="display:flex;align-items:flex-start;gap:8px;padding:5px 0;border-bottom:.5px solid #F0EDE8;">
          <input type="checkbox" ${f.done ? 'checked' : ''} ${write ? '' : 'disabled'} data-act="toggle-followup" data-id="${f.id}" style="width:15px;height:15px;accent-color:var(--cardinal);margin-top:2px;flex-shrink:0;${write ? 'cursor:pointer;' : ''}" />
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;color:var(--navy);${f.done ? 'text-decoration:line-through;opacity:.6;' : ''}">${esc(f.note || 'Follow up')}</div>
            <div style="font-size:11.5px;color:${over ? 'var(--cardinal)' : '#9CA3AF'};font-weight:${over ? '600' : '400'};">${f.due_date ? esc(formatDateDisplay(f.due_date)) : 'No date'}${over ? ' · overdue' : ''}${f.done && f.done_at ? ' · done ' + esc(formatDateDisplay((f.done_at || '').slice(0, 10))) : ''}</div>
          </div>
          ${write ? `<button class="sac-tl-x" style="opacity:1;" title="Delete" data-act="del-followup" data-id="${f.id}">×</button>` : ''}
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
    case 'add-note': await addNote(id); break;
    case 'del-note': await deleteNote(id); break;
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
  render();
}
async function deleteNote(noteId) {
  const d = selected(); if (!d || !canWriteDiscerner(d)) return;
  const { error } = await withWriteRetry(() => sb.from('discernment_notes').delete().eq('id', noteId), { kind: 'update' });
  if (error) { reportWriteError('discernment note delete', error); return; }
  _notesByD[d.id] = (_notesByD[d.id] || []).filter(n => n.id !== noteId);
  render();
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
  render();
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
  const { error } = await withWriteRetry(() => sb.from('discernment_followups').delete().eq('id', followupId), { kind: 'update' });
  if (error) { reportWriteError('discernment follow-up delete', error); return; }
  _followByD[d.id] = (_followByD[d.id] || []).filter(x => x.id !== followupId);
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
  window.closeModal();
  render();
}

// ── Intake modal (create) / edit modal — inline-identity vs link-existing ────
function openIntake(d = null) {
  if (d ? !canWriteDiscerner(d) : !canCreate()) return;
  // Dispose any picker left over from a modal closed via Cancel / overlay click
  // (those paths bypass _cleanupIntake) so we rebuild a fresh one.
  try { _picker?.destroy?.(); } catch (_) {}
  _picker = null;
  const isEdit = !!d;
  _M = {
    id: d?.id || null, isEdit,
    mode: d ? (d.person_id ? 'link' : 'inline') : 'inline',
    personId: d?.person_id || null,
  };
  const vocOpts = Object.entries(VOCATION_TYPES).map(([k, l]) =>
    `<option value="${k}"${d?.vocation_type === k ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const stageOpts = [...STAGE_LADDER, ...TERMINAL_STAGES].map(s =>
    `<option value="${esc(s)}"${s === STARTING_STAGE ? ' selected' : ''}>${esc(s)}</option>`).join('');

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">${isEdit ? 'Edit discernment file' : 'New discernment file'}</div>

    <label>Identity</label>
    <div style="display:flex;gap:8px;margin-bottom:.5rem;">
      <button type="button" class="cf-btn" id="disc-mode-inline" data-mode="inline">Inline (not in directory)</button>
      <button type="button" class="cf-btn" id="disc-mode-link" data-mode="link">Link directory person</button>
    </div>

    <div id="disc-inline-fields" style="display:none;">
      <label>Name</label><input type="text" id="disc-name" value="${esc(d?.person_id ? '' : (d?.name || ''))}" placeholder="Full name" />
      <div style="display:flex;gap:8px;">
        <div style="flex:1;"><label>Phone</label><input type="tel" id="disc-phone" value="${esc(d?.phone || '')}" /></div>
        <div style="flex:1;"><label>Email</label><input type="email" id="disc-email" value="${esc(d?.email || '')}" /></div>
      </div>
    </div>
    <div id="disc-link-fields" style="display:none;">
      <label>Directory person</label>
      <div id="disc-person-picker"></div>
      <div style="font-size:11px;color:#9CA3AF;margin-top:4px;">Name &amp; contact derive from the directory entry.</div>
    </div>

    <label style="margin-top:.75rem;">Vocation type</label>
    <select id="disc-voc">${vocOpts}</select>

    ${isEdit ? '' : `<label>Starting stage</label><select id="disc-start-stage">${stageOpts}</select>`}

    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" id="disc-intake-save">${isEdit ? 'Save' : 'Create file'}</button>
    </div>`;
  document.getElementById('modal-overlay').classList.add('open');

  document.getElementById('disc-mode-inline').addEventListener('click', () => setIntakeMode('inline'));
  document.getElementById('disc-mode-link').addEventListener('click', () => setIntakeMode('link'));
  document.getElementById('disc-intake-save').addEventListener('click', () => saveIntake());
  setIntakeMode(_M.mode);
}
function setIntakeMode(mode) {
  _M.mode = mode;
  const inlineWrap = document.getElementById('disc-inline-fields');
  const linkWrap = document.getElementById('disc-link-fields');
  if (!inlineWrap || !linkWrap) return;
  inlineWrap.style.display = mode === 'inline' ? 'block' : 'none';
  linkWrap.style.display = mode === 'link' ? 'block' : 'none';
  document.getElementById('disc-mode-inline').classList.toggle('active', mode === 'inline');
  document.getElementById('disc-mode-link').classList.toggle('active', mode === 'link');
  if (mode === 'link' && !_picker) {
    _picker = createContactPicker({
      container: document.getElementById('disc-person-picker'),
      placeholder: 'Search the directory…',
      initialValue: _M.personId || undefined,
      onSelect: (p) => { _M.personId = p?.id || null; },
    });
  }
}
async function saveIntake() {
  const voc = document.getElementById('disc-voc')?.value;
  if (!voc) { alert('Vocation type is required.'); return; }
  let personId = null, name = null, phone = null, email = null;
  if (_M.mode === 'link') {
    personId = _picker?.getId() || _M.personId || null;
    if (!personId) { alert('Select a directory person, or switch to Inline.'); return; }
  } else {
    name = (document.getElementById('disc-name')?.value || '').trim();
    phone = (document.getElementById('disc-phone')?.value || '').trim() || null;
    email = (document.getElementById('disc-email')?.value || '').trim() || null;
    if (!name) { alert('Name is required (or link a directory person).'); return; }
  }

  if (_M.isEdit) {
    const d = _discerners.find(x => x.id === _M.id); if (!d) return;
    const patch = { person_id: personId, name, phone, email, vocation_type: voc, updated_at: nowIso() };
    const { error } = await withWriteRetry(() => sb.from('discerners').update(patch).eq('id', d.id), { kind: 'update' });
    if (error) { reportWriteError('discernment update', error); return; }
    Object.assign(d, patch);
    logActivity({ action: 'updated discernment file', entityType: 'discerner', entityName: discernerName(d), contextType: 'discernment', contextId: d.id });
    _cleanupIntake();
    render();
    return;
  }

  // Create: insert the file, then write the FIRST transition (NULL → starting stage).
  // Omit parish_id when unknown so the DB default current_parish_id() applies
  // (passing null would violate NOT NULL). supabase-js drops undefined keys.
  const parishId = store.parishSettings?.id || undefined;
  const startStage = document.getElementById('disc-start-stage')?.value || STARTING_STAGE;
  const { data, error } = await insertWithRetry('discerners', {
    parish_id: parishId, person_id: personId, name, phone, email,
    vocation_type: voc, author_id: _authUserId,
  }, { select: '*' });
  if (error) { reportWriteError('discernment create', error); return; }
  _discerners.unshift(data);
  const { data: tr } = await insertWithRetry('discernment_stage_transitions', {
    discerner_id: data.id, parish_id: data.parish_id, from_stage: null, to_stage: startStage,
    transitioned_at: nowIso(), transitioned_by: _authUserId,
  }, { select: '*' });
  if (tr) (_transByD[data.id] = _transByD[data.id] || []).push(tr);
  logActivity({ action: 'created discernment file', entityType: 'discerner', entityName: discernerName(data), contextType: 'discernment', contextId: data.id });
  _cleanupIntake();
  selectDiscerner(data.id);   // open the new file (also re-renders via hashchange)
  render();
}
function _cleanupIntake() {
  try { _picker?.destroy?.(); } catch (_) {}
  _picker = null; _M = null;
  window.closeModal();
}

// ── Globals (HTML onclick + cross-link entry) ────────────────────────────────
Object.assign(window, {
  expandDiscerner,
  discAddFollowup: (id) => addFollowup(id),
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
