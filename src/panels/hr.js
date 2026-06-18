// ── Human Resources panel — Stage 2 ─────────────────────────────────────────
// Per-institution org-tree editor, occupancy link/unlink + contractor fast-add,
// vacancy walk-up resolver, and the read-only occupancy card (with employment-
// type feature-gating). Record-creation forms (review/disciplinary/incident/
// memo) and the %-grant UI are deferred to Stages 3/4.
//
// Conventions matched: panel loader registered in main.js; modals via
// modal-content.innerHTML + modal-overlay.open / closeModal(); CSS component
// idiom (.card/.btn-*/.modal-*); node actions use event delegation with
// e.target.closest('[data-action]'). Structural writes lean on Stage 1 RLS
// (parish-scoped SELECT, is_admin() writes) — no new policies here.

import { sb } from '../supabase.js';
import { store } from '../store.js';
import { isAdmin, isSuperAdmin } from '../roles.js';
import { closeModal } from '../ui/modal.js';
import { logActivity, todayCST } from '../utils.js';
import { ensureIdentities, userName, fetchGrantRow } from '../ui/grants.js';

// ── Constants ───────────────────────────────────────────────────────────────

const EMP_TYPES = [
  { v: 'full_time', label: 'Full-Time' },
  { v: 'part_time', label: 'Part-Time' },
  { v: 'contract',  label: 'Contract' },
];
const EMP_LABEL = { full_time: 'Full-Time', part_time: 'Part-Time', contract: 'Contract' };
const EMP_COLOR = {
  full_time: { bg: '#E7F0E9', fg: '#2E6B43' },
  part_time: { bg: '#FDF3E0', fg: '#9A6A1E' },
  contract:  { bg: '#EEEAF6', fg: '#5B4A8A' },
};

// Record-type registry. Keys match the Stage 1 record_grants / RLS record_type
// values. `banner` = whether the on-screen per-file banner shows on its view.
const RECORD_META = {
  review:       { table: 'performance_reviews',  label: 'Performance Review',  banner: true  },
  disciplinary: { table: 'disciplinary_records', label: 'Disciplinary Record', banner: true  },
  incident:     { table: 'incident_reports',     label: 'Incident Report',     banner: true  },
  memo:         { table: 'memos',                label: 'Memo',                banner: false },
};

// Employment-type feature-gating for the CREATE surface (Stage 3 definition):
// contract → incident + memo ONLY (no performance review/comp, no disciplinary).
function creatableRecordTypes(empType) {
  return empType === 'contract'
    ? ['incident', 'memo']
    : ['review', 'disciplinary', 'incident', 'memo'];
}

// Live settings reads — never hardcode (Phase 3 severity ladder, Phase 5 banner).
function severityLadder() {
  const l = store.parishSettings?.hr_severity_ladder;
  return Array.isArray(l) && l.length ? l : ['verbal', 'written', 'final', 'termination'];
}
function bannerText() {
  return store.parishSettings?.hr_banner_text
    || "ParishDesk should not replace an employee's physical personnel file.";
}

// Starter review-template library (constant — NEVER mutated; picking one only
// PRE-FILLS the builder, which then saves a NEW parish-scoped review_templates
// row). Minimal, clearly-refinable seed content; the field machinery matters
// more than the text.
const STARTER_TEMPLATES = [
  {
    name: 'General Staff — Annual',
    definition: [
      { type: 'descriptive', prompt: 'Overall performance this period', labels: ['Below', 'Meets', 'Exceeds'] },
      { type: 'numeric', prompt: 'Reliability & punctuality', min: 1, max: 5, allow_na: false },
      { type: 'numeric', prompt: 'Quality of work', min: 1, max: 5, allow_na: false },
      { type: 'selective', prompt: 'Recommended for continued service?', options: ['yes', 'no'] },
      { type: 'text', prompt: 'Strengths and areas for growth' },
    ],
  },
  {
    name: '90-Day Introductory',
    definition: [
      { type: 'selective', prompt: 'Meeting expectations for the role?', options: ['yes', 'no'] },
      { type: 'numeric', prompt: 'Integration with the team', min: 1, max: 5, allow_na: true },
      { type: 'text', prompt: 'Goals for the next period' },
    ],
  },
];

function genId() { return 'f_' + Math.random().toString(36).slice(2, 10); }

// ── Module state ────────────────────────────────────────────────────────────

let _activeInstId = null;
const _expanded = new Set();   // expanded position ids; persists across reloads
let _ctx = null;               // built context (see buildContext)
let _insts = [];
let _people = [];              // all personnel (incl. inactive, for name lookup)
let _authUserId = null;        // current auth user id (record author + RLS mirror)
let _profilesByUser = new Map(); // auth user_id -> personnel_id (author names)
let _templates = [];           // review_templates rows (parish-scoped)
let _templatePositions = [];   // review_template_positions rows
let _builder = null;           // active template-builder working state
let _card = null;              // active occupancy-card context for record modals

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function canManageTabs() { return isSuperAdmin(); }
function canEditTree()   { return isAdmin(); }   // admin OR super_admin

function empBadge(v) {
  const c = EMP_COLOR[v] || { bg: '#EEE', fg: '#555' };
  return `<span style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:3px;background:${c.bg};color:${c.fg};">${EMP_LABEL[v] || v}</span>`;
}
function adminBadge() {
  return `<span title="Administrator seat" style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:3px;background:#FDEAED;color:#8B1A2F;">Administrator</span>`;
}

// Resolve a record's author_id (auth user id) to a display name via
// user_profiles -> personnel.
function authorName(userId) {
  if (!userId) return 'Unknown';
  if (userId === _authUserId && store.currentUserProfile?.personnel?.name) {
    return store.currentUserProfile.personnel.name;
  }
  const personnelId = _profilesByUser.get(userId);
  const p = personnelId && _people.find(x => x.id === personnelId);
  return p ? p.name : 'Staff member';
}

// UI mirror of the Stage 1 UPDATE/DELETE RLS (author OR super_admin).
function canModifyRecord(rec) {
  return isSuperAdmin() || (rec.author_id && rec.author_id === _authUserId);
}

// ── Data ────────────────────────────────────────────────────────────────────

export async function loadHr() {
  const root = document.getElementById('hr-root');
  if (!root) return;
  if (!isAdmin()) {
    root.innerHTML = '<div style="padding:2rem;color:#6B7280;font-size:13px;">You do not have access to Human Resources.</div>';
    return;
  }
  root.style.cssText = '';   // clear the Stage-1 stub centering
  root.innerHTML = '<div style="padding:1rem;"><span class="pulse"></span></div>';

  const [instRes, peopleRes, posRes, occRes] = await Promise.all([
    sb.from('institutions').select('*').order('sort_order').order('name'),
    sb.from('personnel').select('id,name,type,employment,institution,active').order('name'),
    sb.from('positions').select('*').is('archived_at', null),
    sb.from('person_positions').select('*'),
  ]);
  if (posRes.error) {
    root.innerHTML = `<div style="padding:2rem;color:#A32D2D;font-size:13px;">Failed to load the org tree: ${esc(posRes.error.message)}<br><span style="color:#6B7280;">Has the Stage 2 migration (positions.archived_at) been applied?</span></div>`;
    return;
  }

  _insts  = instRes.data || [];
  _people = peopleRes.data || [];
  _ctx    = buildContext(posRes.data || [], occRes.data || []);

  // Identity, author-name map, and review templates (for the record surface).
  const [authRes, profRes, tmplRes, tmplPosRes] = await Promise.all([
    sb.auth.getUser(),
    sb.from('user_profiles').select('user_id, personnel_id'),
    sb.from('review_templates').select('*').order('name'),
    sb.from('review_template_positions').select('*'),
  ]);
  _authUserId        = authRes.data?.user?.id || null;
  _profilesByUser    = new Map((profRes.data || []).map(p => [p.user_id, p.personnel_id]));
  _templates         = tmplRes.data || [];
  _templatePositions = tmplPosRes.data || [];

  if (!_activeInstId || !_insts.some(i => i.id === _activeInstId)) {
    _activeInstId = _insts[0]?.id || null;
  }
  render();
}

// Index positions + occupancies for fast tree rendering and the resolver.
function buildContext(positions, occupancies) {
  const posById = new Map();
  const childrenByParent = new Map();   // parentId|null -> [position]
  positions.forEach(p => {
    posById.set(p.id, p);
    const key = p.parent_position_id || '__root__';
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(p);
  });
  // Stable child order by title.
  childrenByParent.forEach(arr => arr.sort((a, b) => a.title.localeCompare(b.title)));

  const currentByPos = new Map();   // posId -> [occ] where unlinked_at IS NULL
  const allByPos     = new Map();   // posId -> [occ] (incl. historical)
  occupancies.forEach(o => {
    if (!allByPos.has(o.position_id)) allByPos.set(o.position_id, []);
    allByPos.get(o.position_id).push(o);
    if (!o.unlinked_at) {
      if (!currentByPos.has(o.position_id)) currentByPos.set(o.position_id, []);
      currentByPos.get(o.position_id).push(o);
    }
  });

  const personName = (id) => _people.find(p => p.id === id)?.name || 'Unknown';
  return { posById, childrenByParent, currentByPos, allByPos, personName };
}

// Descendant set of a position (for the move cycle-guard).
function descendantsOf(positionId, ctx) {
  const out = new Set();
  const stack = [...(ctx.childrenByParent.get(positionId) || [])];
  while (stack.length) {
    const node = stack.pop();
    if (out.has(node.id)) continue;
    out.add(node.id);
    (ctx.childrenByParent.get(node.id) || []).forEach(c => stack.push(c));
  }
  return out;
}

// ── PHASE 5 — vacancy walk-up resolver (pure, presentational only) ──────────
// Walk UP the parent chain; return the nearest ANCESTOR that is_administrator
// AND currently occupied. Skip vacant admin seats. Fall back to the pastor /
// super-admin (the sole cross-institution backstop) if none is found.
export function resolveEffectiveSupervisor(positionId, ctx) {
  const start = ctx.posById.get(positionId);
  let parentId = start ? start.parent_position_id : null;
  while (parentId) {
    const anc = ctx.posById.get(parentId);
    if (!anc) break;
    const occ = ctx.currentByPos.get(anc.id);
    if (anc.is_administrator && occ && occ.length) {
      return { kind: 'position', name: ctx.personName(occ[0].person_id), title: anc.title };
    }
    parentId = anc.parent_position_id;
  }
  const pastor = _people.find(p => p.type === 'pastor');
  return { kind: 'pastor', name: pastor ? pastor.name : 'the Pastor', title: 'Pastor' };
}

// ── Render: panel shell + institution tabs ──────────────────────────────────

function render() {
  const root = document.getElementById('hr-root');
  if (!root) return;

  const tabs = _insts.map((inst, i) => {
    const active = inst.id === _activeInstId;
    const mgmt = canManageTabs() ? `
      <span data-action="move-inst" data-inst-id="${inst.id}" data-dir="left"  title="Move left"  style="cursor:pointer;color:#9CA3AF;padding:0 2px;${i === 0 ? 'visibility:hidden;' : ''}">‹</span>
      <span data-action="move-inst" data-inst-id="${inst.id}" data-dir="right" title="Move right" style="cursor:pointer;color:#9CA3AF;padding:0 2px;${i === _insts.length - 1 ? 'visibility:hidden;' : ''}">›</span>
      <span data-action="rename-inst" data-inst-id="${inst.id}" title="Rename institution" style="cursor:pointer;color:#9CA3AF;padding:0 2px;">⚙</span>` : '';
    return `<div class="hr-tab" data-action="select-tab" data-inst-id="${inst.id}" style="
        display:inline-flex;align-items:center;gap:2px;padding:.5rem .85rem;cursor:pointer;white-space:nowrap;
        font-size:13px;font-family:'Inter',sans-serif;font-weight:${active ? '600' : '400'};
        color:${active ? 'var(--navy)' : '#6B7280'};border-bottom:2px solid ${active ? 'var(--cardinal)' : 'transparent'};margin-bottom:-1px;">
      <i class="fa-solid ${inst.icon || 'fa-building'}" style="font-size:12px;color:#8B1A2F;margin-right:5px;"></i>
      <span>${esc(inst.name)}</span>${mgmt}
    </div>`;
  }).join('');

  const addInst = canManageTabs()
    ? `<button class="btn-secondary" data-action="add-inst" style="margin-left:auto;">+ Institution</button>` : '';

  root.innerHTML = `
    <div style="padding:1.1rem 1.1rem 0;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 1rem;">
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:700;color:var(--navy);margin:0;">Human Resources</h1>
        ${isAdmin() ? `<button class="btn-secondary" data-action="open-templates">Review Templates</button>` : ''}
      </div>
      <div style="display:flex;align-items:flex-end;gap:0;border-bottom:.5px solid var(--stone);margin-bottom:1.1rem;overflow-x:auto;">
        ${tabs || '<span style="font-size:13px;color:#6B7280;padding:.5rem 0;">No institutions yet.</span>'}
        ${addInst}
      </div>
      <div id="hr-tree"></div>
    </div>`;

  renderTree();

  // Single delegated handler for tabs + tree node actions (replaces on re-render).
  root.onclick = onHrClick;
}

// ── PHASE 3 — tree render ───────────────────────────────────────────────────

function renderTree() {
  const el = document.getElementById('hr-tree');
  if (!el) return;
  if (!_activeInstId) { el.innerHTML = ''; return; }

  const roots = _ctx.childrenByParent.get('__root__')?.filter(p => p.institution_id === _activeInstId) || [];
  const addRoot = canEditTree()
    ? `<button class="btn-secondary" data-action="add-root" style="margin-bottom:.85rem;">+ Add position</button>` : '';

  const body = roots.length
    ? roots.map(p => renderNode(p, 0)).join('')
    : `<div style="font-size:13px;color:#6B7280;font-style:italic;padding:.5rem 0;">No positions in this institution yet.${canEditTree() ? ' Add a root position to begin.' : ''}</div>`;

  el.innerHTML = `<div class="card" style="padding:1rem 1.1rem;">${addRoot}${body}</div>`;
}

function renderNode(pos, depth) {
  const children = _ctx.childrenByParent.get(pos.id) || [];
  const hasChildren = children.length > 0;
  const isOpen = _expanded.has(pos.id);
  const current = _ctx.currentByPos.get(pos.id) || [];
  const vacant = current.length === 0;

  const caret = hasChildren
    ? `<span data-action="toggle" data-pos-id="${pos.id}" style="cursor:pointer;display:inline-block;width:14px;color:#9CA3AF;font-size:11px;">${isOpen ? '▾' : '▸'}</span>`
    : `<span style="display:inline-block;width:14px;"></span>`;

  // Occupant chips (or Vacant marker)
  const occHtml = vacant
    ? `<span style="font-size:11.5px;color:#B45309;font-weight:600;">Vacant</span>`
    : current.map(o => `
        <span style="display:inline-flex;align-items:center;gap:5px;background:#F6F4F0;border-radius:4px;padding:1px 6px;">
          <span data-action="view-occ" data-occ-id="${o.id}" style="cursor:pointer;font-size:12.5px;color:var(--navy);font-weight:500;text-decoration:underline;text-decoration-color:#D6CEC2;">${esc(_ctx.personName(o.person_id))}</span>
          ${empBadge(o.employment_type)}
          ${canEditTree() ? `<span data-action="unlink" data-occ-id="${o.id}" title="Unlink (soft)" style="cursor:pointer;color:#B45309;font-size:11px;">✕</span>` : ''}
        </span>`).join(' ');

  // Vacant admin seat → presentational supervision fallback
  let resolverLine = '';
  if (pos.is_administrator && vacant) {
    const r = resolveEffectiveSupervisor(pos.id, _ctx);
    resolverLine = `<div style="font-size:11px;color:#6B7280;font-style:italic;margin-top:2px;">Supervision currently resolves to: <strong style="font-style:normal;color:#374151;">${esc(r.name)}</strong>${r.kind === 'pastor' ? ' (Pastor)' : ` (${esc(r.title)})`}</div>`;
  }

  const actions = canEditTree() ? `
    <div class="hr-node-actions" style="display:flex;gap:8px;flex-shrink:0;align-items:center;">
      <button class="card-action" data-action="link"      data-pos-id="${pos.id}">Link</button>
      <button class="card-action" data-action="add-child" data-pos-id="${pos.id}">+ Child</button>
      <button class="card-action" data-action="fastadd"   data-pos-id="${pos.id}" title="Fast-add a contractor under this position">+ Contractor</button>
      <button class="card-action" data-action="edit-pos"  data-pos-id="${pos.id}">Edit</button>
      <button class="card-action" data-action="move-pos"  data-pos-id="${pos.id}">Move</button>
      <button class="card-action" data-action="archive"   data-pos-id="${pos.id}" style="color:#9A6A1E;">Archive</button>
      <button class="card-action" data-action="delete"    data-pos-id="${pos.id}" style="color:#A32D2D;">Delete</button>
    </div>` : '';

  const row = `
    <div style="display:flex;align-items:flex-start;gap:10px;padding:.55rem 0;border-bottom:.5px solid #F0EDE8;padding-left:${depth * 22}px;">
      <div style="flex:1;min-width:0;display:flex;align-items:flex-start;gap:6px;">
        ${caret}
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span style="font-weight:600;font-size:13.5px;color:var(--navy);">${esc(pos.title)}</span>
            ${pos.is_administrator ? adminBadge() : ''}
          </div>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px;">${occHtml}</div>
          ${resolverLine}
        </div>
      </div>
      ${actions}
    </div>`;

  const kids = (hasChildren && isOpen)
    ? children.map(c => renderNode(c, depth + 1)).join('')
    : '';
  return row + kids;
}

// ── Event delegation ────────────────────────────────────────────────────────

function onHrClick(e) {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  const action = t.dataset.action;
  const posId  = t.dataset.posId;
  const occId  = t.dataset.occId;
  const instId = t.dataset.instId;

  switch (action) {
    case 'select-tab':  _activeInstId = instId; render(); break;
    case 'move-inst':   reorderInstitution(instId, t.dataset.dir); break;
    case 'rename-inst': openInstitutionModal(instId); break;
    case 'add-inst':    openInstitutionModal(null); break;
    case 'open-templates': openTemplateManager(); break;
    case 'toggle':      _expanded.has(posId) ? _expanded.delete(posId) : _expanded.add(posId); renderTree(); break;
    case 'add-root':    openPositionModal(null, null); break;
    case 'add-child':   openPositionModal(null, posId); break;
    case 'edit-pos':    openPositionModal(posId, null); break;
    case 'move-pos':    openMoveModal(posId); break;
    case 'link':        openLinkModal(posId); break;
    case 'fastadd':     openFastAddModal(posId); break;
    case 'archive':     archivePosition(posId); break;
    case 'delete':      deletePosition(posId); break;
    case 'unlink':      unlinkOccupancy(occId); break;
    case 'view-occ':    openOccupancyCard(occId); break;
  }
}

// ── PHASE 2 — institution add / rename / reorder (super-admin) ───────────────

function openModalHtml(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('open');
}

function openInstitutionModal(id) {
  if (!canManageTabs()) return;
  const inst = id ? _insts.find(i => i.id === id) : null;
  openModalHtml(`
    <div class="modal-title">${inst ? 'Rename institution' : 'Add institution'}</div>
    <label>Name</label><input id="hr-inst-name" value="${esc(inst?.name || '')}" placeholder="e.g. Cathedral School" />
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="window.hrSaveInstitution(${inst ? `'${inst.id}'` : 'null'})">Save</button>
    </div>`);
}

async function hrSaveInstitution(id) {
  const name = document.getElementById('hr-inst-name').value.trim();
  if (!name) { alert('Name is required.'); return; }
  if (id) {
    const old = _insts.find(i => i.id === id);
    const { error } = await sb.from('institutions').update({ name }).eq('id', id);
    if (error) { alert('Save failed: ' + error.message); return; }
    // Cascade the rename to personnel.institution (name-based link, per existing convention).
    if (old && old.name !== name) {
      await sb.from('personnel').update({ institution: name, updated_at: new Date().toISOString() }).eq('institution', old.name);
    }
    logActivity({ action: 'renamed institution', entityType: 'institution', entityName: name });
  } else {
    const nextOrder = _insts.length ? Math.max(..._insts.map(i => i.sort_order ?? 0)) + 1 : 0;
    const { data, error } = await sb.from('institutions').insert({ name, sort_order: nextOrder }).select('id').single();
    if (error) { alert('Save failed: ' + error.message); return; }
    _activeInstId = data?.id || _activeInstId;
    logActivity({ action: 'added institution', entityType: 'institution', entityName: name });
  }
  closeModal();
  await loadHr();
}

// Reorder by renumbering sort_order across all institutions in the new order.
async function reorderInstitution(id, dir) {
  if (!canManageTabs()) return;
  const ordered = [..._insts];
  const idx = ordered.findIndex(i => i.id === id);
  const swap = dir === 'left' ? idx - 1 : idx + 1;
  if (idx < 0 || swap < 0 || swap >= ordered.length) return;
  [ordered[idx], ordered[swap]] = [ordered[swap], ordered[idx]];
  await Promise.all(ordered.map((inst, i) =>
    inst.sort_order === i ? null : sb.from('institutions').update({ sort_order: i }).eq('id', inst.id)
  ).filter(Boolean));
  await loadHr();
}

// ── PHASE 3 — position add / edit / move ────────────────────────────────────

function openPositionModal(posId, parentId) {
  if (!canEditTree()) return;
  const pos = posId ? _ctx.posById.get(posId) : null;
  const parent = parentId ? _ctx.posById.get(parentId) : (pos ? _ctx.posById.get(pos.parent_position_id) : null);
  const heading = pos ? 'Edit position' : (parent ? `Add position under “${esc(parent.title)}”` : 'Add root position');
  openModalHtml(`
    <div class="modal-title">${heading}</div>
    <label>Title</label><input id="hr-pos-title" value="${esc(pos?.title || '')}" placeholder="e.g. Director of Music" />
    <label>Duties</label><textarea id="hr-pos-duties" rows="3" placeholder="Optional">${esc(pos?.duties || '')}</textarea>
    <label style="display:flex;align-items:center;gap:8px;margin-top:.6rem;cursor:pointer;">
      <input type="checkbox" id="hr-pos-admin" ${pos?.is_administrator ? 'checked' : ''} style="width:auto;margin:0;" />
      <span>Administrator seat (supervises subordinate positions)</span>
    </label>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="window.hrSavePosition(${pos ? `'${pos.id}'` : 'null'}, ${parentId ? `'${parentId}'` : 'null'})">Save</button>
    </div>`);
}

async function hrSavePosition(posId, parentId) {
  const title = document.getElementById('hr-pos-title').value.trim();
  if (!title) { alert('Title is required.'); return; }
  const duties = document.getElementById('hr-pos-duties').value.trim() || null;
  const is_administrator = document.getElementById('hr-pos-admin').checked;

  if (posId) {
    const { error } = await sb.from('positions').update({ title, duties, is_administrator, updated_at: new Date().toISOString() }).eq('id', posId);
    if (error) { alert('Save failed: ' + error.message); return; }
  } else {
    const { error } = await sb.from('positions').insert({
      institution_id: _activeInstId,
      parent_position_id: parentId || null,
      title, duties, is_administrator,
    });
    if (error) { alert('Save failed: ' + error.message); return; }
    if (parentId) _expanded.add(parentId);
  }
  logActivity({ action: posId ? 'updated position' : 'created position', entityType: 'position', entityName: title });
  closeModal();
  await loadHr();
}

function openMoveModal(posId) {
  if (!canEditTree()) return;
  const pos = _ctx.posById.get(posId);
  if (!pos) return;
  const banned = descendantsOf(posId, _ctx);   // cycle guard: self + descendants
  banned.add(posId);
  const targets = [..._ctx.posById.values()]
    .filter(p => p.institution_id === _activeInstId && !banned.has(p.id))
    .sort((a, b) => a.title.localeCompare(b.title));
  const opts = [`<option value="">— Root of this institution —</option>`]
    .concat(targets.map(p => `<option value="${p.id}"${pos.parent_position_id === p.id ? ' selected' : ''}>${esc(p.title)}</option>`))
    .join('');
  openModalHtml(`
    <div class="modal-title">Move “${esc(pos.title)}”</div>
    <label>New parent</label>
    <select id="hr-move-parent">${opts}</select>
    <div style="font-size:11.5px;color:#6B7280;margin-top:.4rem;">A position cannot be moved under itself or any of its descendants.</div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="window.hrSaveMove('${posId}')">Move</button>
    </div>`);
}

async function hrSaveMove(posId) {
  const newParent = document.getElementById('hr-move-parent').value || null;
  const { error } = await sb.from('positions').update({ parent_position_id: newParent, updated_at: new Date().toISOString() }).eq('id', posId);
  if (error) { alert('Move failed: ' + error.message); return; }
  if (newParent) _expanded.add(newParent);
  closeModal();
  await loadHr();
}

// ── PHASE 4 — occupancy link / unlink / contractor fast-add ─────────────────

function personPickerOptions(selectedId) {
  return _people.filter(p => p.active !== false)
    .map(p => `<option value="${p.id}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)}</option>`)
    .join('');
}
function empTypeOptions(selected) {
  return EMP_TYPES.map(t => `<option value="${t.v}"${t.v === selected ? ' selected' : ''}>${t.label}</option>`).join('');
}

function openLinkModal(posId) {
  if (!canEditTree()) return;
  const pos = _ctx.posById.get(posId);
  if (!pos) return;
  openModalHtml(`
    <div class="modal-title">Link person to “${esc(pos.title)}”</div>
    <label>Person</label>
    <select id="hr-link-person"><option value="">— Select —</option>${personPickerOptions()}</select>
    <label>Employment type</label>
    <select id="hr-link-emp">${empTypeOptions('full_time')}</select>
    <div style="font-size:11.5px;color:#6B7280;margin-top:.4rem;">A person may hold several positions; linking never removes existing occupancies.</div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="window.hrSaveLink('${posId}')">Link</button>
    </div>`);
}

async function hrSaveLink(posId) {
  const personId = document.getElementById('hr-link-person').value;
  const empType  = document.getElementById('hr-link-emp').value;
  if (!personId) { alert('Select a person.'); return; }
  const { error } = await sb.from('person_positions').insert({
    person_id: personId, position_id: posId, employment_type: empType,
  });
  if (error) { alert('Link failed: ' + error.message); return; }
  _expanded.add(posId);
  logActivity({ action: 'linked person to position', entityType: 'person_position', entityName: _ctx.posById.get(posId)?.title || '' });
  closeModal();
  await loadHr();
}

async function unlinkOccupancy(occId) {
  if (!canEditTree()) return;
  const occ = (_ctx.allByPos.get([..._ctx.allByPos.keys()].find(k => (_ctx.allByPos.get(k) || []).some(o => o.id === occId))) || [])
    .find(o => o.id === occId);
  const name = occ ? _ctx.personName(occ.person_id) : 'this person';
  if (!confirm(`Unlink ${name} from this position? Their record history is preserved; other positions are untouched.`)) return;
  const { error } = await sb.from('person_positions').update({ unlinked_at: new Date().toISOString() }).eq('id', occId);
  if (error) { alert('Unlink failed: ' + error.message); return; }
  logActivity({ action: 'unlinked person from position', entityType: 'person_position', entityName: name });
  await loadHr();
}

// Contractor fast-add: one modal → parent (preselected) + position title +
// existing-or-new person + employment_type (defaults to contract) → writes the
// position AND the person_positions link in one action.
function openFastAddModal(parentId) {
  if (!canEditTree()) return;
  const parent = parentId ? _ctx.posById.get(parentId) : null;
  openModalHtml(`
    <div class="modal-title">Fast-add contractor${parent ? ` under “${esc(parent.title)}”` : ''}</div>
    <label>Position title</label><input id="hr-fa-title" placeholder="e.g. HVAC Contractor" />
    <label>Duties</label><textarea id="hr-fa-duties" rows="2" placeholder="Optional"></textarea>
    <label>Person</label>
    <select id="hr-fa-person" onchange="window.hrFaToggle()">
      <option value="">— Select existing —</option>
      ${personPickerOptions()}
      <option value="__new">+ New person…</option>
    </select>
    <div id="hr-fa-newwrap" style="display:none;border-left:2px solid var(--stone);padding-left:.7rem;margin-top:.5rem;">
      <label>Full name</label><input id="hr-fa-name" placeholder="e.g. Acme Mechanical / John Smith" />
      <label>Phone</label><input id="hr-fa-phone" placeholder="Optional" />
      <label>Email</label><input id="hr-fa-email" placeholder="Optional" />
    </div>
    <label>Employment type</label>
    <select id="hr-fa-emp">${empTypeOptions('contract')}</select>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="window.hrSaveFastAdd(${parentId ? `'${parentId}'` : 'null'})">Add</button>
    </div>`);
}

function hrFaToggle() {
  const isNew = document.getElementById('hr-fa-person').value === '__new';
  document.getElementById('hr-fa-newwrap').style.display = isNew ? '' : 'none';
}

async function hrSaveFastAdd(parentId) {
  const title = document.getElementById('hr-fa-title').value.trim();
  if (!title) { alert('Position title is required.'); return; }
  const duties = document.getElementById('hr-fa-duties').value.trim() || null;
  const empType = document.getElementById('hr-fa-emp').value;
  let personId = document.getElementById('hr-fa-person').value;

  if (!personId) { alert('Select or create a person.'); return; }

  // 1. Create the new personnel row if requested.
  if (personId === '__new') {
    const name = document.getElementById('hr-fa-name').value.trim();
    if (!name) { alert('Enter the new person’s name.'); return; }
    const instName = _insts.find(i => i.id === _activeInstId)?.name || null;
    const { data, error } = await sb.from('personnel').insert({
      name,
      phone: document.getElementById('hr-fa-phone').value.trim() || null,
      email: document.getElementById('hr-fa-email').value.trim() || null,
      institution: instName,
      type: 'staff',
      employment: 'under-contract',
      active: true,
    }).select('id').single();
    if (error) { alert('Could not create person: ' + error.message); return; }
    personId = data.id;
  }

  // 2. Create the position.
  const { data: posRow, error: posErr } = await sb.from('positions').insert({
    institution_id: _activeInstId, parent_position_id: parentId || null, title, duties,
  }).select('id').single();
  if (posErr) { alert('Could not create position: ' + posErr.message); return; }

  // 3. Link the occupancy.
  const { error: linkErr } = await sb.from('person_positions').insert({
    person_id: personId, position_id: posRow.id, employment_type: empType,
  });
  if (linkErr) { alert('Position created, but linking failed: ' + linkErr.message); }

  if (parentId) _expanded.add(parentId);
  logActivity({ action: 'fast-added contractor position', entityType: 'position', entityName: title });
  closeModal();
  await loadHr();
}

// ── PHASE 4 — removal rules (archive vs hard-delete) ────────────────────────

async function archivePosition(posId) {
  if (!canEditTree()) return;
  const pos = _ctx.posById.get(posId);
  if (!pos) return;
  if ((_ctx.childrenByParent.get(posId) || []).length) {
    alert('This position still has child positions. Move or remove them first, then archive.');
    return;
  }
  if (!confirm(`Archive “${pos.title}”? It leaves the active tree but its records and occupancy history are preserved.`)) return;
  const { error } = await sb.from('positions').update({ archived_at: new Date().toISOString() }).eq('id', posId);
  if (error) { alert('Archive failed: ' + error.message); return; }
  logActivity({ action: 'archived position', entityType: 'position', entityName: pos.title });
  await loadHr();
}

async function deletePosition(posId) {
  if (!canEditTree()) return;
  const pos = _ctx.posById.get(posId);
  if (!pos) return;
  if ((_ctx.childrenByParent.get(posId) || []).length) {
    alert('This position still has child positions. Move or remove them first.');
    return;
  }
  // Any occupancy ever (current OR historical) → archive-only, never hard-delete.
  if ((_ctx.allByPos.get(posId) || []).length) {
    alert('This position has occupancy history and cannot be deleted — archive it instead to preserve record provenance.');
    return;
  }
  if (!confirm(`Delete “${pos.title}”? It has never had an occupant, so it can be permanently removed.`)) return;
  const { error } = await sb.from('positions').delete().eq('id', posId);
  if (error) { alert('Delete failed: ' + error.message); return; }
  logActivity({ action: 'deleted position', entityType: 'position', entityName: pos.title });
  await loadHr();
}

// ── PHASE 6 — occupancy card (read view + feature-gating display) ────────────

async function openOccupancyCard(occId) {
  // Locate the occupancy and its position.
  let occ = null, posId = null;
  for (const [pid, list] of _ctx.allByPos) {
    const found = list.find(o => o.id === occId);
    if (found) { occ = found; posId = pid; break; }
  }
  if (!occ) return;
  const pos = _ctx.posById.get(posId);
  const personName = _ctx.personName(occ.person_id);
  // Card context for record modals (record binds to THIS person_position id = occ.id).
  _card = { occId, ppId: occ.id, positionId: posId, empType: occ.employment_type };

  // Full link/unlink history for THIS position (succession).
  const history = [...(_ctx.allByPos.get(posId) || [])]
    .sort((a, b) => new Date(b.linked_at) - new Date(a.linked_at))
    .map(o => {
      const cur = !o.unlinked_at;
      return `<div style="display:flex;justify-content:space-between;gap:10px;padding:.35rem 0;border-bottom:.5px solid #F0EDE8;font-size:12px;">
        <span style="color:var(--navy);font-weight:${o.id === occId ? '700' : '500'};">${esc(_ctx.personName(o.person_id))} ${empBadge(o.employment_type)}</span>
        <span style="color:#6B7280;white-space:nowrap;">${fmtDay(o.linked_at)} → ${cur ? '<strong style="color:#2E6B43;">current</strong>' : fmtDay(o.unlinked_at)}</span>
      </div>`;
    }).join('');

  // Records on THIS occupancy the viewer may see (RLS returns only the permitted).
  const records = await fetchOccupancyRecords(occ.id);
  const recordsHtml = records.length
    ? records.map(r => recordRow(r)).join('')
    : `<div style="font-size:12.5px;color:#6B7280;font-style:italic;padding:.3rem 0;">No records on this occupancy yet.</div>`;

  // Create surface — admin/super-admin only, gated by employment_type.
  const createBtns = isAdmin()
    ? creatableRecordTypes(occ.employment_type).map(rt =>
        `<button class="btn-secondary" style="font-size:12px;" onclick="window.hrNewRecord('${rt}')">+ ${RECORD_META[rt].label}</button>`).join(' ')
    : '';
  const contractNote = (isAdmin() && occ.employment_type === 'contract')
    ? `<div style="font-size:11px;color:#9CA3AF;margin-top:.35rem;">Contract occupancy — performance review &amp; disciplinary records do not apply.</div>` : '';

  openModalHtml(`
    <div class="modal-title">${esc(personName)}</div>
    <div style="font-size:13px;color:var(--navy);font-weight:600;">${esc(pos?.title || '')}${pos?.is_administrator ? ' ' + adminBadge() : ''}</div>
    <div style="margin:.3rem 0 .9rem;">${empBadge(occ.employment_type)}</div>
    ${pos?.duties ? `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.25rem;">Duties</div><div style="font-size:13px;color:#374151;line-height:1.5;margin-bottom:1rem;">${esc(pos.duties)}</div>` : ''}

    <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.3rem;">Occupancy history</div>
    <div style="margin-bottom:1rem;">${history}</div>

    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:.5rem;">
      <span style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#9CA3AF;text-transform:uppercase;">HR records</span>
    </div>
    ${createBtns ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:.7rem;">${createBtns}</div>${contractNote}` : ''}
    <div style="margin-bottom:1rem;">${recordsHtml}</div>

    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Close</button>
    </div>`);
}

// Fetch the four record types for a person_position; tag each with its record
// type. RLS scopes the result to what the viewer may see.
async function fetchOccupancyRecords(ppId) {
  const [rev, dis, inc, mem] = await Promise.all([
    sb.from('performance_reviews').select('*').eq('person_position_id', ppId),
    sb.from('disciplinary_records').select('*').eq('person_position_id', ppId),
    sb.from('incident_reports').select('*').eq('person_position_id', ppId),
    sb.from('memos').select('*').eq('person_position_id', ppId),
  ]);
  const tag = (res, type) => (res.data || []).map(r => ({ ...r, _type: type }));
  return [...tag(rev, 'review'), ...tag(dis, 'disciplinary'), ...tag(inc, 'incident'), ...tag(mem, 'memo')]
    .sort((a, b) => new Date(b.record_date || b.created_at) - new Date(a.record_date || a.created_at));
}

function recordRow(r) {
  const meta = RECORD_META[r._type];
  const date = r.record_date ? fmtDay(r.record_date) : fmtDay(r.created_at);
  return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:.45rem .6rem;background:#F8F7F4;border:.5px solid var(--stone);border-radius:6px;margin-bottom:.4rem;">
    <div style="min-width:0;">
      <div style="font-size:12.5px;color:var(--navy);font-weight:600;">${meta.label}</div>
      <div style="font-size:11px;color:#6B7280;">${date} · ${esc(authorName(r.author_id))}</div>
    </div>
    <div style="display:flex;gap:8px;flex-shrink:0;">
      <button class="card-action" onclick="window.hrViewRecord('${r._type}','${r.id}')">View</button>
      ${canModifyRecord(r) ? `<button class="card-action" onclick="window.hrEditRecord('${r._type}','${r.id}')">Edit</button>
      <button class="card-action" style="color:#A32D2D;" onclick="window.hrDeleteRecord('${r._type}','${r.id}')">Delete</button>` : ''}
    </div>
  </div>`;
}

function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ════════════════════════════════════════════════════════════════════════════
// STAGE 3 — RECORDS, CROSS-LINKING, TEMPLATE BUILDER, SNAPSHOT, BANNER
// ════════════════════════════════════════════════════════════════════════════

const val     = (id) => document.getElementById(id)?.value ?? '';
const checked = (id) => !!document.getElementById(id)?.checked;
const nowIso  = () => new Date().toISOString();
const todayISO = () => todayCST();

// Phase 5 banner — placed in disciplinary / incident / review VIEWS only.
// Rendered as text (textContent) after the modal HTML is set, never innerHTML.
function bannerBlock() {
  return `<div class="hr-banner" style="font-size:10.5px;color:#B9A88F;font-style:italic;border-top:.5px solid var(--stone);margin-top:1rem;padding-top:.55rem;line-height:1.5;"></div>`;
}
function showRecordModal(html) {
  openModalHtml(html);
  document.querySelectorAll('#modal-content .hr-banner').forEach(el => { el.textContent = bannerText(); });
}
function metaLine(rec) {
  const date = rec.record_date ? fmtDay(rec.record_date) : fmtDay(rec.created_at);
  return `<div style="font-size:11.5px;color:#6B7280;margin-bottom:1rem;">${date} · ${esc(authorName(rec.author_id))}</div>`;
}
function reopenCard() { if (_card) openOccupancyCard(_card.occId); }

// PHASE 3 — grantee header. Shown only when the CURRENT viewer sees the file
// via a grant (not author, not super_admin). Reads the grant row live, so it
// shows even before a reason note is added. Distinct from the Stage 3 banner.
async function granteeHeaderHtml(type, rec) {
  if (isSuperAdmin() || rec.author_id === _authUserId) return '';
  await ensureIdentities();
  const grant = await fetchGrantRow(type, rec.id, _authUserId);
  if (!grant) return '';   // access not via grant — no header
  const granter = grant.granted_by ? userName(grant.granted_by) : 'an administrator';
  return `<div style="background:#EEEAF6;border:.5px solid #D6CDEC;border-radius:6px;padding:.5rem .7rem;margin-bottom:.85rem;font-size:12px;color:#4A3D74;">
    <i class="fa-solid fa-key" style="margin-right:5px;"></i><strong>Access granted by ${esc(granter)}</strong>${grant.note ? ` — ${esc(grant.note)}` : ''}
    <div style="font-size:10.5px;color:#7A6BA6;margin-top:2px;">This file is not yours — you are viewing it under a specific grant.</div>
  </div>`;
}
function exportBtn(type, id) {
  return `<button class="btn-secondary" onclick="window.hrExportPdf('${type}','${id}')">Export PDF</button>`;
}

// ── PHASE 5 — single-record PDF export (re-render, banner-swap, provenance) ──
// Inherits view access (the button only exists on a record the user can already
// see). Re-renders the record's fields into the document (no DOM scraping); for
// reviews, from frozen_definition + answers. Carries a provenance stamp instead
// of the on-screen "don't replace the physical file" banner.
function recordToSections(type, rec) {
  if (type === 'memo') {
    return { title: 'Memo', sections: [['Subject', rec.subject || ''], ['Body', rec.body || '']] };
  }
  if (type === 'incident') {
    return { title: 'Incident Report', sections: [['Description', rec.description || '']] };
  }
  if (type === 'disciplinary') {
    return { title: 'Disciplinary Record', sections: [
      ['Severity', rec.severity || '—'],
      ['Narrative', rec.narrative || ''],
      ['Corrective action', rec.corrective_action || '—'],
      ['Signed physical copy on file', rec.signed_on_file ? `Yes${rec.signed_date ? ' (' + fmtDay(rec.signed_date) + ')' : ''}` : 'No'],
    ] };
  }
  // review — render from the snapshot (frozen_definition + answers)
  const def = Array.isArray(rec.frozen_definition) ? rec.frozen_definition : [];
  const ans = rec.answers || {};
  const sections = [];
  if (rec.review_period_start || rec.review_period_end) {
    sections.push(['Review period', `${rec.review_period_start ? fmtDay(rec.review_period_start) : '…'} – ${rec.review_period_end ? fmtDay(rec.review_period_end) : '…'}`]);
  }
  def.forEach(f => {
    const a = ans[f.id];
    sections.push([f.prompt || '(field)', (a === null || a === undefined || a === '') ? '—' : String(a)]);
  });
  sections.push(['Signed physical copy on file', rec.signed_on_file ? `Yes${rec.signed_date ? ' (' + fmtDay(rec.signed_date) + ')' : ''}` : 'No']);
  return { title: 'Performance Review', sections };
}

async function hrExportPdf(type, id) {
  const rec = await fetchRecord(type, id);
  if (!rec) return;
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const M = 56;                       // margin
  const W = doc.internal.pageSize.getWidth() - M * 2;
  let y = M;
  const { title, sections } = recordToSections(type, rec);

  const who = labelForPP(rec.person_position_id);   // person — position (best effort)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(28, 43, 58);
  doc.text(title, M, y); y += 20;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(107, 114, 128);
  doc.text(who.replace(/<[^>]+>/g, ''), M, y); y += 14;
  const dateStr = rec.record_date ? fmtDay(rec.record_date) : fmtDay(rec.created_at);
  doc.text(`${dateStr} · ${authorName(rec.author_id)}`, M, y); y += 22;

  sections.forEach(([label, value]) => {
    if (y > doc.internal.pageSize.getHeight() - 80) { doc.addPage(); y = M; }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(120, 120, 120);
    doc.text(String(label).toUpperCase(), M, y); y += 13;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(40, 40, 40);
    const lines = doc.splitTextToSize(String(value || '—'), W);
    lines.forEach(ln => {
      if (y > doc.internal.pageSize.getHeight() - 80) { doc.addPage(); y = M; }
      doc.text(ln, M, y); y += 15;
    });
    y += 8;
  });

  // BANNER-SWAP: provenance stamp (NOT the on-screen physical-file banner).
  const me = store.currentUserProfile?.personnel?.name || 'Unknown user';
  const stamp = `Exported from ParishDesk by ${me} on ${new Date().toLocaleString('en-US')}`;
  doc.setFont('helvetica', 'italic'); doc.setFontSize(8); doc.setTextColor(150, 150, 150);
  doc.text(stamp, M, doc.internal.pageSize.getHeight() - 36);

  const safe = (s) => String(s).replace(/[^a-z0-9]+/gi, '_').slice(0, 40);
  doc.save(`${safe(title)}_${safe(who.replace(/<[^>]+>/g, ''))}.pdf`);
  logActivity({ action: 'exported record to PDF', entityType: 'hr_record', entityName: `${type}:${id}`, contextType: 'hr' });
}

// ── Dispatch (called from card / record-row buttons) ────────────────────────

function hrNewRecord(type) {
  if (!isAdmin() || !_card) return;
  if (!creatableRecordTypes(_card.empType).includes(type)) return;
  if (type === 'memo')              openMemoForm(null);
  else if (type === 'incident')     openIncidentForm(null);
  else if (type === 'disciplinary') openDisciplinaryForm(null);
  else if (type === 'review')       openReviewCreate();
}
async function fetchRecord(type, id) {
  const { data } = await sb.from(RECORD_META[type].table).select('*').eq('id', id).maybeSingle();
  return data;
}
async function hrViewRecord(type, id) {
  const rec = await fetchRecord(type, id);
  if (!rec) return;
  if (type === 'memo')              viewMemo(rec);
  else if (type === 'incident')     viewIncident(rec);
  else if (type === 'disciplinary') viewDisciplinary(rec);
  else if (type === 'review')       viewReview(rec);
}
async function hrEditRecord(type, id) {
  const rec = await fetchRecord(type, id);
  if (!rec || !canModifyRecord(rec)) return;
  if (type === 'memo')              openMemoForm(rec);
  else if (type === 'incident')     openIncidentForm(rec);
  else if (type === 'disciplinary') openDisciplinaryForm(rec);
  else if (type === 'review')       openReviewEdit(rec);
}
async function hrDeleteRecord(type, id) {
  const meta = RECORD_META[type];
  if (!confirm(`Delete this ${meta.label.toLowerCase()}? This cannot be undone.`)) return;
  const { error } = await sb.from(meta.table).delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  logActivity({ action: `deleted ${meta.label.toLowerCase()}`, entityType: 'hr_record', entityName: meta.label });
  reopenCard();
}

// ── PHASE 2 — MEMO (no banner) ──────────────────────────────────────────────

function openMemoForm(rec) {
  openModalHtml(`
    <div class="modal-title">${rec ? 'Edit memo' : 'New memo'}</div>
    <label>Subject</label><input id="hr-memo-subject" value="${esc(rec?.subject || '')}" />
    <label>Body</label><textarea id="hr-memo-body" rows="5">${esc(rec?.body || '')}</textarea>
    <label>Date</label><input type="date" id="hr-memo-date" value="${rec?.record_date || todayISO()}" />
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.hrReopenCard()">Cancel</button>
      <button class="btn-primary" onclick="window.hrSaveMemo(${rec ? `'${rec.id}'` : 'null'})">Save</button>
    </div>`);
}
async function hrSaveMemo(id) {
  const subject = val('hr-memo-subject').trim();
  const body    = val('hr-memo-body').trim();
  const record_date = val('hr-memo-date') || null;
  if (!subject && !body) { alert('Enter a subject or body.'); return; }
  const fields = { subject: subject || null, body: body || null, record_date };
  let error;
  if (id) ({ error } = await sb.from('memos').update({ ...fields, updated_at: nowIso() }).eq('id', id));
  else    ({ error } = await sb.from('memos').insert({ ...fields, person_position_id: _card.ppId, author_id: _authUserId }));
  if (error) { alert('Save failed: ' + error.message); return; }
  reopenCard();
}
async function viewMemo(rec) {
  const gh = await granteeHeaderHtml('memo', rec);
  openModalHtml(`
    <div class="modal-title">${esc(rec.subject || 'Memo')}</div>
    ${gh}
    ${metaLine(rec)}
    <div style="font-size:13.5px;color:#374151;line-height:1.6;white-space:pre-wrap;">${esc(rec.body || '')}</div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.hrReopenCard()">Back</button>
      ${exportBtn('memo', rec.id)}
      ${canModifyRecord(rec) ? `<button class="btn-primary" onclick="window.hrEditRecord('memo','${rec.id}')">Edit</button>` : ''}
    </div>`);
}

// ── PHASE 3 — INCIDENT REPORT (banner; cross-link to disciplinary) ──────────

function openIncidentForm(rec) {
  openModalHtml(`
    <div class="modal-title">${rec ? 'Edit incident report' : 'New incident report'}</div>
    <label>Description</label><textarea id="hr-inc-desc" rows="6">${esc(rec?.description || '')}</textarea>
    <label>Date</label><input type="date" id="hr-inc-date" value="${rec?.record_date || todayISO()}" />
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.hrReopenCard()">Cancel</button>
      <button class="btn-primary" onclick="window.hrSaveIncident(${rec ? `'${rec.id}'` : 'null'})">Save</button>
    </div>`);
}
async function hrSaveIncident(id) {
  const description = val('hr-inc-desc').trim();
  const record_date = val('hr-inc-date') || null;
  if (!description) { alert('A description is required.'); return; }
  let error;
  if (id) ({ error } = await sb.from('incident_reports').update({ description, record_date, updated_at: nowIso() }).eq('id', id));
  else    ({ error } = await sb.from('incident_reports').insert({ description, record_date, person_position_id: _card.ppId, author_id: _authUserId }));
  if (error) { alert('Save failed: ' + error.message); return; }
  reopenCard();
}
async function viewIncident(rec) {
  const [linked, gh] = await Promise.all([fetchLinks('incident', rec.id), granteeHeaderHtml('incident', rec)]);
  showRecordModal(`
    <div class="modal-title">Incident Report</div>
    ${gh}
    ${metaLine(rec)}
    <div style="font-size:13.5px;color:#374151;line-height:1.6;white-space:pre-wrap;margin-bottom:1rem;">${esc(rec.description || '')}</div>
    ${crossLinkSection('incident', rec.id, linked)}
    ${bannerBlock()}
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.hrReopenCard()">Back</button>
      ${exportBtn('incident', rec.id)}
      ${canModifyRecord(rec) ? `<button class="btn-primary" onclick="window.hrEditRecord('incident','${rec.id}')">Edit</button>` : ''}
    </div>`);
}

// ── PHASE 3 — DISCIPLINARY RECORD (banner; severity ladder; cross-link) ─────

function openDisciplinaryForm(rec) {
  const ladder = severityLadder();
  const sevOpts = ['<option value="">— Select —</option>']
    .concat(ladder.map(s => `<option value="${esc(s)}"${rec?.severity === s ? ' selected' : ''}>${esc(s.charAt(0).toUpperCase() + s.slice(1))}</option>`))
    .join('');
  openModalHtml(`
    <div class="modal-title">${rec ? 'Edit disciplinary record' : 'New disciplinary record'}</div>
    <label>Narrative</label><textarea id="hr-dis-narr" rows="5">${esc(rec?.narrative || '')}</textarea>
    <label>Severity</label><select id="hr-dis-sev">${sevOpts}</select>
    <label>Corrective action</label><textarea id="hr-dis-corr" rows="3">${esc(rec?.corrective_action || '')}</textarea>
    <label>Date</label><input type="date" id="hr-dis-date" value="${rec?.record_date || todayISO()}" />
    <label style="display:flex;align-items:center;gap:8px;margin-top:.6rem;cursor:pointer;">
      <input type="checkbox" id="hr-dis-signed" ${rec?.signed_on_file ? 'checked' : ''} style="width:auto;margin:0;" onchange="window.hrDisSignedToggle()" />
      <span>Signed physical copy on file</span>
    </label>
    <div id="hr-dis-signedwrap" style="display:${rec?.signed_on_file ? '' : 'none'};">
      <label>Signed date</label><input type="date" id="hr-dis-signeddate" value="${rec?.signed_date || ''}" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.hrReopenCard()">Cancel</button>
      <button class="btn-primary" onclick="window.hrSaveDisciplinary(${rec ? `'${rec.id}'` : 'null'})">Save</button>
    </div>`);
}
function hrDisSignedToggle() {
  document.getElementById('hr-dis-signedwrap').style.display = checked('hr-dis-signed') ? '' : 'none';
}
async function hrSaveDisciplinary(id) {
  const narrative = val('hr-dis-narr').trim();
  if (!narrative) { alert('A narrative is required.'); return; }
  const signed = checked('hr-dis-signed');
  const fields = {
    narrative,
    severity: val('hr-dis-sev') || null,
    corrective_action: val('hr-dis-corr').trim() || null,
    record_date: val('hr-dis-date') || null,
    signed_on_file: signed,
    signed_date: signed ? (val('hr-dis-signeddate') || null) : null,
  };
  let error;
  if (id) ({ error } = await sb.from('disciplinary_records').update({ ...fields, updated_at: nowIso() }).eq('id', id));
  else    ({ error } = await sb.from('disciplinary_records').insert({ ...fields, person_position_id: _card.ppId, author_id: _authUserId }));
  if (error) { alert('Save failed: ' + error.message); return; }
  reopenCard();
}
async function viewDisciplinary(rec) {
  const [linked, gh] = await Promise.all([fetchLinks('disciplinary', rec.id), granteeHeaderHtml('disciplinary', rec)]);
  const field = (label, value) => value
    ? `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.2rem;">${label}</div><div style="font-size:13.5px;color:#374151;line-height:1.6;white-space:pre-wrap;margin-bottom:.85rem;">${esc(value)}</div>` : '';
  const signed = rec.signed_on_file
    ? `<div style="font-size:12px;color:#2E6B43;margin-bottom:.85rem;">✓ Signed physical copy on file${rec.signed_date ? ` (${fmtDay(rec.signed_date)})` : ''}</div>`
    : `<div style="font-size:12px;color:#9CA3AF;margin-bottom:.85rem;">Signed copy not yet on file</div>`;
  showRecordModal(`
    <div class="modal-title">Disciplinary Record</div>
    ${gh}
    ${metaLine(rec)}
    ${rec.severity ? `<div style="margin-bottom:.85rem;"><span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:3px;background:#FDEAED;color:#8B1A2F;">${esc(rec.severity.toUpperCase())}</span></div>` : ''}
    ${field('Narrative', rec.narrative)}
    ${field('Corrective action', rec.corrective_action)}
    ${signed}
    ${crossLinkSection('disciplinary', rec.id, linked)}
    ${bannerBlock()}
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.hrReopenCard()">Back</button>
      ${exportBtn('disciplinary', rec.id)}
      ${canModifyRecord(rec) ? `<button class="btn-primary" onclick="window.hrEditRecord('disciplinary','${rec.id}')">Edit</button>` : ''}
    </div>`);
}

// ── Cross-linking (incident_disciplinary_links, read both directions) ───────

// For a record of `type` ('incident'|'disciplinary') return the linked records
// of the OPPOSITE type (full rows), via the single join table.
async function fetchLinks(type, id) {
  const col = type === 'incident' ? 'incident_id' : 'disciplinary_id';
  const otherCol = type === 'incident' ? 'disciplinary_id' : 'incident_id';
  const otherTable = type === 'incident' ? 'disciplinary_records' : 'incident_reports';
  const { data: links } = await sb.from('incident_disciplinary_links').select('*').eq(col, id);
  const otherIds = (links || []).map(l => l[otherCol]);
  let rows = [];
  if (otherIds.length) {
    const { data } = await sb.from(otherTable).select('*').in('id', otherIds);
    rows = (data || []).map(r => {
      const link = links.find(l => l[otherCol] === r.id);
      return { ...r, _linkId: link?.id };
    });
  }
  return rows;
}
function linkLabel(otherType, rec) {
  const who = labelForPP(rec.person_position_id);
  const date = rec.record_date ? fmtDay(rec.record_date) : fmtDay(rec.created_at);
  const head = otherType === 'incident' ? (rec.description || 'Incident') : (rec.severity ? rec.severity + ' — ' : '') + (rec.narrative || 'Disciplinary');
  return `${who} · ${date} · ${esc(String(head).slice(0, 50))}`;
}
function labelForPP(ppId) {
  for (const [pid, list] of _ctx.allByPos) {
    const o = list.find(x => x.id === ppId);
    if (o) { const pos = _ctx.posById.get(pid); return esc(_ctx.personName(o.person_id)) + (pos ? ' — ' + esc(pos.title) : ''); }
  }
  return 'Record';
}
function crossLinkSection(type, id, linkedRows) {
  const otherType  = type === 'incident' ? 'disciplinary' : 'incident';
  const otherLabel = type === 'incident' ? 'disciplinary records' : 'incident reports';
  const rows = linkedRows.length
    ? linkedRows.map(r => `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:.35rem 0;font-size:12px;border-bottom:.5px solid #F0EDE8;">
        <span style="cursor:pointer;color:var(--navy);text-decoration:underline;text-decoration-color:#D6CEC2;" onclick="window.hrViewRecord('${otherType}','${r.id}')">${linkLabel(otherType, r)}</span>
        ${isAdmin() ? `<span title="Remove link" style="cursor:pointer;color:#B45309;flex-shrink:0;" onclick="window.hrRemoveLink('${r._linkId}','${type}','${id}')">✕</span>` : ''}
      </div>`).join('')
    : `<div style="font-size:12px;color:#9CA3AF;font-style:italic;">None linked.</div>`;
  const adder = isAdmin()
    ? `<button class="card-action" style="margin-top:.4rem;" onclick="window.hrOpenLinkPicker('${type}','${id}')">+ Link ${otherLabel}</button>` : '';
  return `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.3rem;margin-top:.4rem;">Linked ${otherLabel}</div>${rows}${adder}`;
}
// Picker: opposite-type records the viewer can see (RLS-scoped), not already linked.
async function hrOpenLinkPicker(type, id) {
  const otherType  = type === 'incident' ? 'disciplinary' : 'incident';
  const otherTable = type === 'incident' ? 'disciplinary_records' : 'incident_reports';
  const existing = (await fetchLinks(type, id)).map(r => r.id);
  const { data } = await sb.from(otherTable).select('*');
  const candidates = (data || []).filter(r => !existing.includes(r.id));
  const opts = candidates.length
    ? candidates.map(r => `<option value="${r.id}">${linkLabel(otherType, r)}</option>`).join('')
    : '';
  openModalHtml(`
    <div class="modal-title">Link ${otherType === 'incident' ? 'incident report' : 'disciplinary record'}</div>
    ${candidates.length
      ? `<label>Choose a record</label><select id="hr-link-target">${opts}</select>`
      : `<div style="font-size:13px;color:#6B7280;">No other records are available to link.</div>`}
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.hrViewRecord('${type}','${id}')">Cancel</button>
      ${candidates.length ? `<button class="btn-primary" onclick="window.hrAddLink('${type}','${id}')">Link</button>` : ''}
    </div>`);
}
async function hrAddLink(type, id) {
  const targetId = val('hr-link-target');
  if (!targetId) return;
  const row = type === 'incident'
    ? { incident_id: id, disciplinary_id: targetId }
    : { disciplinary_id: id, incident_id: targetId };
  const { error } = await sb.from('incident_disciplinary_links').insert(row);
  if (error) { alert('Link failed: ' + error.message); return; }
  hrViewRecord(type, id);   // reopen the originating record's view
}
async function hrRemoveLink(linkId, type, id) {
  const { error } = await sb.from('incident_disciplinary_links').delete().eq('id', linkId);
  if (error) { alert('Remove failed: ' + error.message); return; }
  hrViewRecord(type, id);
}

// ── PHASE 4b/4c — PERFORMANCE REVIEW (create with snapshot, view from snapshot)

let _reviewDraft = null;   // { templateId, definition, editingId }

function openReviewCreate() {
  const posId = _card.positionId;
  const assignedIds = new Set(_templatePositions.filter(tp => tp.position_id === posId).map(tp => tp.template_id));
  const assigned = _templates.filter(t => assignedIds.has(t.id));
  if (!assigned.length) {
    openModalHtml(`
      <div class="modal-title">Performance Review</div>
      <div style="font-size:13px;color:#6B7280;line-height:1.6;">No review templates are assigned to this position. Assign one via <strong>Review Templates</strong> first.</div>
      <div class="modal-actions"><button class="btn-secondary" onclick="window.hrReopenCard()">Back</button></div>`);
    return;
  }
  if (assigned.length === 1) { renderReviewForm(assigned[0]); return; }
  openModalHtml(`
    <div class="modal-title">Choose a review template</div>
    <div style="font-size:12px;color:#6B7280;margin-bottom:.6rem;">This position has multiple templates.</div>
    ${assigned.map(t => `<button class="btn-secondary" style="display:block;width:100%;text-align:left;margin-bottom:6px;" onclick="window.hrPickReviewTemplate('${t.id}')">${esc(t.name)}</button>`).join('')}
    <div class="modal-actions"><button class="btn-secondary" onclick="window.hrReopenCard()">Cancel</button></div>`);
}
function hrPickReviewTemplate(id) { renderReviewForm(_templates.find(t => t.id === id)); }

// Editing a saved review renders from its FROZEN definition (never the live
// template), preserving the snapshot.
function openReviewEdit(rec) {
  renderReviewForm(
    { id: rec.template_id, name: 'Saved review', definition: Array.isArray(rec.frozen_definition) ? rec.frozen_definition : [] },
    rec
  );
}

function fieldInput(f, existingAnswer) {
  const aid = `hr-ans-${f.id}`;
  const head = `<label style="font-weight:600;">${esc(f.prompt || '(no prompt)')}</label>`;
  if (f.type === 'numeric') {
    const naId = `hr-na-${f.id}`;
    const isNa = existingAnswer === 'N/A';
    const naBox = f.allow_na
      ? `<label style="display:inline-flex;align-items:center;gap:5px;font-weight:400;margin-left:10px;cursor:pointer;"><input type="checkbox" id="${naId}" ${isNa ? 'checked' : ''} style="width:auto;margin:0;" onchange="document.getElementById('${aid}').disabled=this.checked" /> N/A</label>` : '';
    return `${head}<div style="display:flex;align-items:center;gap:4px;margin-bottom:.6rem;">
      <input type="number" id="${aid}" min="${f.min}" max="${f.max}" step="1" value="${isNa ? '' : esc(existingAnswer ?? '')}" ${isNa ? 'disabled' : ''} style="width:90px;" />
      <span style="font-size:11px;color:#9CA3AF;">(${f.min}–${f.max})</span>${naBox}
    </div>`;
  }
  if (f.type === 'descriptive') {
    return `${head}<select id="${aid}" style="margin-bottom:.6rem;"><option value="">— Select —</option>${(f.labels || []).map(l => `<option value="${esc(l)}"${existingAnswer === l ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  }
  if (f.type === 'selective') {
    return `${head}<select id="${aid}" style="margin-bottom:.6rem;"><option value="">— Select —</option>${(f.options || []).map(o => `<option value="${esc(o)}"${existingAnswer === o ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  return `${head}<textarea id="${aid}" rows="3" style="margin-bottom:.6rem;">${esc(existingAnswer ?? '')}</textarea>`;
}

function renderReviewForm(template, existing) {
  const definition = Array.isArray(template.definition) ? template.definition : [];
  _reviewDraft = { templateId: template.id || null, definition, editingId: existing?.id || null };
  const answers = existing?.answers || {};
  const fields = definition.map(f => fieldInput(f, answers[f.id])).join('');
  openModalHtml(`
    <div class="modal-title">${existing ? 'Edit' : 'New'} Performance Review</div>
    <div style="font-size:12px;color:#6B7280;margin-bottom:.7rem;">Template: ${esc(template.name || '')}${existing ? ' (structure frozen at creation)' : ''}</div>
    ${fields || '<div style="font-size:12.5px;color:#9CA3AF;">This template has no fields.</div>'}
    <div style="border-top:.5px solid var(--stone);margin:.6rem 0 .4rem;padding-top:.6rem;"></div>
    <div style="display:flex;gap:10px;">
      <div style="flex:1;"><label>Period start</label><input type="date" id="hr-rev-start" value="${existing?.review_period_start || ''}" /></div>
      <div style="flex:1;"><label>Period end</label><input type="date" id="hr-rev-end" value="${existing?.review_period_end || ''}" /></div>
    </div>
    <label>Review date</label><input type="date" id="hr-rev-date" value="${existing?.review_date || todayISO()}" />
    <label style="display:flex;align-items:center;gap:8px;margin-top:.6rem;cursor:pointer;">
      <input type="checkbox" id="hr-rev-signed" ${existing?.signed_on_file ? 'checked' : ''} style="width:auto;margin:0;" onchange="document.getElementById('hr-rev-signedwrap').style.display=this.checked?'':'none'" />
      <span>Signed physical copy on file</span>
    </label>
    <div id="hr-rev-signedwrap" style="display:${existing?.signed_on_file ? '' : 'none'};">
      <label>Signed date</label><input type="date" id="hr-rev-signeddate" value="${existing?.signed_date || ''}" />
    </div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.hrReopenCard()">Cancel</button>
      <button class="btn-primary" onclick="window.hrSaveReview()">Save</button>
    </div>`);
}

async function hrSaveReview() {
  const def = _reviewDraft.definition;
  const answers = {};
  for (const f of def) {
    const aid = `hr-ans-${f.id}`;
    if (f.type === 'numeric') {
      if (f.allow_na && checked(`hr-na-${f.id}`)) { answers[f.id] = 'N/A'; continue; }
      const raw = val(aid);
      if (raw === '') { answers[f.id] = null; continue; }
      const n = parseInt(raw, 10);
      if (Number.isNaN(n) || n < f.min || n > f.max) { alert(`“${f.prompt}” must be a whole number from ${f.min} to ${f.max}.`); return; }
      answers[f.id] = n;
    } else {
      answers[f.id] = val(aid) || null;
    }
  }
  const signed = checked('hr-rev-signed');
  const meta = {
    review_period_start: val('hr-rev-start') || null,
    review_period_end:   val('hr-rev-end') || null,
    review_date:         val('hr-rev-date') || null,
    record_date:         val('hr-rev-date') || todayISO(),
    signed_on_file:      signed,
    signed_date:         signed ? (val('hr-rev-signeddate') || null) : null,
    answers,
  };
  let error;
  if (_reviewDraft.editingId) {
    // Update answers + meta ONLY — frozen_definition stays immutable.
    ({ error } = await sb.from('performance_reviews').update({ ...meta, updated_at: nowIso() }).eq('id', _reviewDraft.editingId));
  } else {
    // THE SNAPSHOT: deep-copy the live definition into frozen_definition now.
    const frozen_definition = JSON.parse(JSON.stringify(def));
    ({ error } = await sb.from('performance_reviews').insert({
      ...meta,
      person_position_id: _card.ppId,
      author_id: _authUserId,
      template_id: _reviewDraft.templateId,
      frozen_definition,
    }));
  }
  if (error) { alert('Save failed: ' + error.message); return; }
  reopenCard();
}

function renderAnswer(f, a) {
  if (a === null || a === undefined || a === '') return '<span style="color:#9CA3AF;">—</span>';
  return esc(String(a));
}
async function viewReview(rec) {
  const gh = await granteeHeaderHtml('review', rec);
  const def = Array.isArray(rec.frozen_definition) ? rec.frozen_definition : [];
  const ans = rec.answers || {};
  const rows = def.map(f => `
    <div style="padding:.4rem 0;border-bottom:.5px solid #F0EDE8;">
      <div style="font-size:12px;color:#6B7280;margin-bottom:1px;">${esc(f.prompt || '')}</div>
      <div style="font-size:13.5px;color:var(--navy);font-weight:500;">${renderAnswer(f, ans[f.id])}</div>
    </div>`).join('');
  const period = (rec.review_period_start || rec.review_period_end)
    ? `<div style="font-size:12px;color:#6B7280;margin-bottom:.6rem;">Period: ${rec.review_period_start ? fmtDay(rec.review_period_start) : '…'} – ${rec.review_period_end ? fmtDay(rec.review_period_end) : '…'}</div>` : '';
  const signed = rec.signed_on_file
    ? `<div style="font-size:12px;color:#2E6B43;margin-top:.6rem;">✓ Signed physical copy on file${rec.signed_date ? ` (${fmtDay(rec.signed_date)})` : ''}</div>` : '';
  showRecordModal(`
    <div class="modal-title">Performance Review</div>
    ${gh}
    ${metaLine(rec)}
    ${period}
    ${rows || '<div style="font-size:12.5px;color:#9CA3AF;">No fields.</div>'}
    ${signed}
    ${bannerBlock()}
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.hrReopenCard()">Back</button>
      ${exportBtn('review', rec.id)}
      ${canModifyRecord(rec) ? `<button class="btn-primary" onclick="window.hrEditRecord('review','${rec.id}')">Edit</button>` : ''}
    </div>`);
}

// ── PHASE 4a — REVIEW TEMPLATE MANAGER + BUILDER (admin+) ───────────────────

async function refreshTemplates() {
  const [tmplRes, tmplPosRes] = await Promise.all([
    sb.from('review_templates').select('*').order('name'),
    sb.from('review_template_positions').select('*'),
  ]);
  _templates = tmplRes.data || [];
  _templatePositions = tmplPosRes.data || [];
}

function openTemplateManager() {
  if (!isAdmin()) return;
  const rows = _templates.length
    ? _templates.map(t => {
        const count = _templatePositions.filter(tp => tp.template_id === t.id).length;
        return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:.5rem .6rem;background:#F8F7F4;border:.5px solid var(--stone);border-radius:6px;margin-bottom:.4rem;">
          <div><div style="font-size:13px;color:var(--navy);font-weight:600;">${esc(t.name)}</div>
          <div style="font-size:11px;color:#6B7280;">${(t.definition || []).length} field${(t.definition || []).length !== 1 ? 's' : ''} · ${count} position${count !== 1 ? 's' : ''}</div></div>
          <div style="display:flex;gap:8px;flex-shrink:0;">
            <button class="card-action" onclick="window.hrEditTemplate('${t.id}')">Edit</button>
            <button class="card-action" style="color:#A32D2D;" onclick="window.hrDeleteTemplate('${t.id}')">Delete</button>
          </div>
        </div>`;
      }).join('')
    : `<div style="font-size:12.5px;color:#6B7280;font-style:italic;margin-bottom:.6rem;">No templates yet.</div>`;
  const starters = STARTER_TEMPLATES.map((s, i) =>
    `<button class="btn-secondary" style="font-size:12px;" onclick="window.hrStartFromStarter(${i})">${esc(s.name)}</button>`).join(' ');
  openModalHtml(`
    <div class="modal-title">Review Templates</div>
    ${rows}
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:.7rem;">
      <button class="btn-primary" style="font-size:12px;" onclick="window.hrNewTemplate()">+ New blank</button>
      ${starters}
    </div>
    <div style="font-size:11px;color:#9CA3AF;margin-top:.5rem;">Starters pre-fill the builder — edit, name, and save to create your own. The starter library is never modified.</div>
    <div class="modal-actions"><button class="btn-secondary" onclick="closeModal()">Close</button></div>`);
}

function newBuilder(seed) {
  // Ensure every field carries a stable id.
  const definition = (seed?.definition || []).map(f => ({ ...f, id: f.id || genId() }));
  return { id: seed?.id || null, name: seed?.name || '', definition, positionIds: new Set(seed?.positionIds || []) };
}
function hrNewTemplate() { _builder = newBuilder(null); renderBuilder(); }
function hrStartFromStarter(i) {
  const s = STARTER_TEMPLATES[i];
  _builder = newBuilder({ name: s.name + ' (copy)', definition: JSON.parse(JSON.stringify(s.definition)) });
  renderBuilder();
}
function hrEditTemplate(id) {
  const t = _templates.find(x => x.id === id);
  if (!t) return;
  const positionIds = _templatePositions.filter(tp => tp.template_id === id).map(tp => tp.position_id);
  _builder = newBuilder({ id: t.id, name: t.name, definition: JSON.parse(JSON.stringify(t.definition || [])), positionIds });
  renderBuilder();
}
async function hrDeleteTemplate(id) {
  if (!confirm('Delete this template? Saved reviews already created from it are unaffected (they keep their own frozen copy).')) return;
  await sb.from('review_template_positions').delete().eq('template_id', id);
  const { error } = await sb.from('review_templates').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  await refreshTemplates();
  openTemplateManager();
}

// Read all builder inputs from the DOM into _builder before any re-render.
function syncBuilderFromDom() {
  if (!_builder) return;
  _builder.name = val('hr-tb-name');
  _builder.definition.forEach((f, idx) => {
    f.prompt = val(`hr-tb-prompt-${idx}`);
    if (f.type === 'numeric') {
      let max = parseInt(val(`hr-tb-max-${idx}`), 10);
      if (Number.isNaN(max)) max = 5;
      f.max = Math.min(10, Math.max(2, max));   // HARD CAP 10, floor 2
      f.min = 1;                                 // FIXED
      f.allow_na = checked(`hr-tb-na-${idx}`);
    } else if (f.type === 'descriptive') {
      f.labels = val(`hr-tb-labels-${idx}`).split(',').map(s => s.trim()).filter(Boolean);
    } else if (f.type === 'selective') {
      f.options = val(`hr-tb-options-${idx}`).split(',').map(s => s.trim()).filter(Boolean);
    }
  });
  const pos = new Set();
  document.querySelectorAll('.hr-tb-pos:checked').forEach(el => pos.add(el.value));
  _builder.positionIds = pos;
}

function builderFieldHtml(f, idx) {
  let cfg = '';
  if (f.type === 'numeric') {
    cfg = `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12px;color:#6B7280;">
      <span>Min <strong>1</strong> (fixed)</span>
      <label style="display:inline-flex;align-items:center;gap:4px;">Max <input type="number" id="hr-tb-max-${idx}" min="2" max="10" step="1" value="${f.max ?? 5}" style="width:64px;" /></label>
      <label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" id="hr-tb-na-${idx}" ${f.allow_na ? 'checked' : ''} style="width:auto;margin:0;" /> Allow N/A</label>
      <span>Whole numbers only</span>
    </div>`;
  } else if (f.type === 'descriptive') {
    cfg = `<label style="font-size:12px;color:#6B7280;">Labels (comma-separated, in order)</label>
      <input id="hr-tb-labels-${idx}" value="${esc((f.labels || []).join(', '))}" placeholder="Below, Meets, Exceeds" />`;
  } else if (f.type === 'selective') {
    cfg = `<label style="font-size:12px;color:#6B7280;">Options (comma-separated)</label>
      <input id="hr-tb-options-${idx}" value="${esc((f.options || []).join(', '))}" placeholder="yes, no" />`;
  } else {
    cfg = `<div style="font-size:12px;color:#9CA3AF;">Freeform text response.</div>`;
  }
  return `<div style="border:.5px solid var(--stone);border-radius:6px;padding:.6rem .7rem;margin-bottom:.5rem;background:#fff;">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:.4rem;">
      <span style="font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#8B1A2F;">${f.type}</span>
      <div style="display:flex;gap:6px;">
        <span title="Move up" style="cursor:pointer;color:#9CA3AF;" onclick="window.hrTbMove(${idx},-1)">▲</span>
        <span title="Move down" style="cursor:pointer;color:#9CA3AF;" onclick="window.hrTbMove(${idx},1)">▼</span>
        <span title="Delete field" style="cursor:pointer;color:#A32D2D;" onclick="window.hrTbDel(${idx})">✕</span>
      </div>
    </div>
    <label>Prompt</label><input id="hr-tb-prompt-${idx}" value="${esc(f.prompt || '')}" placeholder="Question or criterion" />
    <div style="margin-top:.4rem;">${cfg}</div>
  </div>`;
}

function renderBuilder() {
  // Positions grouped by institution for assignment.
  const byInst = new Map();
  for (const p of _ctx.posById.values()) {
    if (!byInst.has(p.institution_id)) byInst.set(p.institution_id, []);
    byInst.get(p.institution_id).push(p);
  }
  const instName = (id) => _insts.find(i => i.id === id)?.name || 'Institution';
  const posChecks = [...byInst.entries()].map(([instId, list]) => `
    <div style="margin-bottom:.4rem;">
      <div style="font-size:11px;font-weight:700;color:#6B7280;text-transform:uppercase;letter-spacing:.04em;margin-bottom:.2rem;">${esc(instName(instId))}</div>
      ${list.sort((a, b) => a.title.localeCompare(b.title)).map(p => `
        <label style="display:flex;align-items:center;gap:7px;font-size:12.5px;padding:.15rem 0;cursor:pointer;">
          <input type="checkbox" class="hr-tb-pos" value="${p.id}" ${_builder.positionIds.has(p.id) ? 'checked' : ''} style="width:auto;margin:0;" />
          <span>${esc(p.title)}</span>
        </label>`).join('')}
    </div>`).join('') || '<div style="font-size:12px;color:#9CA3AF;">No positions to assign yet.</div>';

  const fields = _builder.definition.map((f, idx) => builderFieldHtml(f, idx)).join('');
  openModalHtml(`
    <div class="modal-title">${_builder.id ? 'Edit' : 'New'} review template</div>
    <label>Template name</label><input id="hr-tb-name" value="${esc(_builder.name)}" placeholder="e.g. Catechist — Annual" />
    <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#9CA3AF;text-transform:uppercase;margin:.9rem 0 .4rem;">Fields</div>
    ${fields || '<div style="font-size:12.5px;color:#9CA3AF;margin-bottom:.4rem;">No fields yet.</div>'}
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:.4rem;">
      <button class="btn-secondary" style="font-size:12px;" onclick="window.hrTbAdd('numeric')">+ Numeric</button>
      <button class="btn-secondary" style="font-size:12px;" onclick="window.hrTbAdd('descriptive')">+ Descriptive</button>
      <button class="btn-secondary" style="font-size:12px;" onclick="window.hrTbAdd('selective')">+ Selective</button>
      <button class="btn-secondary" style="font-size:12px;" onclick="window.hrTbAdd('text')">+ Text</button>
    </div>
    <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#9CA3AF;text-transform:uppercase;margin:.9rem 0 .4rem;">Assign to positions</div>
    <div style="max-height:180px;overflow-y:auto;border:.5px solid var(--stone);border-radius:6px;padding:.5rem .6rem;">${posChecks}</div>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="window.hrCloseBuilder()">Cancel</button>
      <button class="btn-primary" onclick="window.hrSaveTemplate()">Save template</button>
    </div>`);
}
function hrCloseBuilder() { _builder = null; openTemplateManager(); }
function hrTbAdd(type) {
  syncBuilderFromDom();
  const base = { id: genId(), type, prompt: '' };
  if (type === 'numeric')     Object.assign(base, { min: 1, max: 5, allow_na: false });
  if (type === 'descriptive') base.labels = ['Below', 'Meets', 'Exceeds'];
  if (type === 'selective')   base.options = ['yes', 'no'];
  _builder.definition.push(base);
  renderBuilder();
}
function hrTbMove(idx, dir) {
  syncBuilderFromDom();
  const j = idx + dir;
  if (j < 0 || j >= _builder.definition.length) return;
  const d = _builder.definition;
  [d[idx], d[j]] = [d[j], d[idx]];
  renderBuilder();
}
function hrTbDel(idx) {
  syncBuilderFromDom();
  _builder.definition.splice(idx, 1);
  renderBuilder();
}
async function hrSaveTemplate() {
  syncBuilderFromDom();
  const name = (_builder.name || '').trim();
  if (!name) { alert('Template name is required.'); return; }
  if (!_builder.definition.length) { alert('Add at least one field.'); return; }
  // Validation (mirrors build-time constraints).
  for (const f of _builder.definition) {
    if (!f.prompt || !f.prompt.trim()) { alert('Every field needs a prompt.'); return; }
    if (f.type === 'numeric') {
      if (!(Number.isInteger(f.max) && f.max >= 2 && f.max <= 10)) { alert(`Numeric max must be a whole number from 2 to 10 (“${f.prompt}”).`); return; }
      f.min = 1;
    }
    if (f.type === 'descriptive' && (!f.labels || f.labels.length < 2)) { alert(`Descriptive field “${f.prompt}” needs at least two labels.`); return; }
    if (f.type === 'selective' && (!f.options || f.options.length < 2)) { alert(`Selective field “${f.prompt}” needs at least two options.`); return; }
  }
  const definition = _builder.definition.map(f => {
    const base = { id: f.id, type: f.type, prompt: f.prompt.trim() };
    if (f.type === 'numeric')     return { ...base, min: 1, max: f.max, allow_na: !!f.allow_na };
    if (f.type === 'descriptive') return { ...base, labels: f.labels };
    if (f.type === 'selective')   return { ...base, options: f.options };
    return base;
  });

  let templateId = _builder.id;
  if (templateId) {
    const { error } = await sb.from('review_templates').update({ name, definition, updated_at: nowIso() }).eq('id', templateId);
    if (error) { alert('Save failed: ' + error.message); return; }
  } else {
    const { data, error } = await sb.from('review_templates').insert({ name, definition, created_by: _authUserId }).select('id').single();
    if (error) { alert('Save failed: ' + error.message); return; }
    templateId = data.id;
  }
  // Re-sync position assignments (delete-all + insert selected).
  await sb.from('review_template_positions').delete().eq('template_id', templateId);
  const ids = [..._builder.positionIds];
  if (ids.length) {
    await sb.from('review_template_positions').insert(ids.map(pid => ({ template_id: templateId, position_id: pid })));
  }
  logActivity({ action: _builder.id ? 'updated review template' : 'created review template', entityType: 'review_template', entityName: name });
  _builder = null;
  await refreshTemplates();
  openTemplateManager();
}

// ── Expose modal-button + record handlers (tree actions use delegation) ─────

Object.assign(window, {
  hrSaveInstitution, hrSavePosition, hrSaveMove, hrSaveLink, hrSaveFastAdd, hrFaToggle,
  // records
  hrReopenCard: reopenCard, hrNewRecord, hrViewRecord, hrEditRecord, hrDeleteRecord, hrExportPdf,
  hrSaveMemo, hrSaveIncident, hrSaveDisciplinary, hrDisSignedToggle,
  // cross-linking
  hrOpenLinkPicker, hrAddLink, hrRemoveLink,
  // reviews
  hrPickReviewTemplate, hrSaveReview,
  // template builder
  hrNewTemplate, hrStartFromStarter, hrEditTemplate, hrDeleteTemplate,
  hrCloseBuilder, hrTbAdd, hrTbMove, hrTbDel, hrSaveTemplate,
});
