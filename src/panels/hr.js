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
import { logActivity } from '../utils.js';

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

// HR record types that apply per employment type (Phase 6 feature-gating).
// Contract excludes performance review / comp; full & part get the full set.
function applicableRecordTypes(empType) {
  return empType === 'contract'
    ? ['Duties', 'Incident Report', 'Memo']
    : ['Performance Review', 'Disciplinary Record', 'Incident Report', 'Memo'];
}

// ── Module state ────────────────────────────────────────────────────────────

let _activeInstId = null;
const _expanded = new Set();   // expanded position ids; persists across reloads
let _ctx = null;               // built context (see buildContext)
let _insts = [];
let _people = [];              // all personnel (incl. inactive, for name lookup)

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
      <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:700;color:var(--navy);margin:0 0 1rem;">Human Resources</h1>
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

function openOccupancyCard(occId) {
  // Locate the occupancy and its position.
  let occ = null, posId = null;
  for (const [pid, list] of _ctx.allByPos) {
    const found = list.find(o => o.id === occId);
    if (found) { occ = found; posId = pid; break; }
  }
  if (!occ) return;
  const pos = _ctx.posById.get(posId);
  const personName = _ctx.personName(occ.person_id);

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

  // Feature-gating outcome (records UI deferred to Stage 3).
  const gated = applicableRecordTypes(occ.employment_type).map(rt =>
    `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:.4rem .6rem;background:#F8F7F4;border:.5px solid var(--stone);border-radius:6px;margin-bottom:.4rem;">
      <span style="font-size:12.5px;color:var(--navy);font-weight:500;">${rt}</span>
      <span style="font-size:10.5px;color:#9CA3AF;font-style:italic;">coming in records stage</span>
    </div>`).join('');
  const excluded = occ.employment_type === 'contract'
    ? `<div style="font-size:11.5px;color:#9CA3AF;margin-top:.3rem;">Performance review &amp; compensation do not apply to contract occupancies.</div>` : '';

  openModalHtml(`
    <div class="modal-title">${esc(personName)}</div>
    <div style="font-size:13px;color:var(--navy);font-weight:600;">${esc(pos?.title || '')}${pos?.is_administrator ? ' ' + adminBadge() : ''}</div>
    <div style="margin:.3rem 0 .9rem;">${empBadge(occ.employment_type)}</div>
    ${pos?.duties ? `<div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.25rem;">Duties</div><div style="font-size:13px;color:#374151;line-height:1.5;margin-bottom:1rem;">${esc(pos.duties)}</div>` : ''}

    <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.3rem;">Occupancy history</div>
    <div style="margin-bottom:1rem;">${history}</div>

    <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.4rem;">Applicable HR records</div>
    ${gated}${excluded}

    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Close</button>
    </div>`);
}

function fmtDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Expose modal-button handlers (tree actions use delegation) ──────────────

Object.assign(window, {
  hrSaveInstitution, hrSavePosition, hrSaveMove, hrSaveLink,
  hrSaveFastAdd, hrFaToggle,
});
