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

import { sb, deleteWithRetry, withWriteRetry } from '../supabase.js';
import { store } from '../store.js';
import { isAdmin, isSuperAdmin, canAccessHr, hrHasAuthority, hrCanManageStructure, hrCanFinalizeSelfReport } from '../roles.js';
import { closeModal } from '../ui/modal.js';
import { logActivity, todayCST, compareByLastName, formatDateMDY } from '../utils.js';
import { ensureIdentities, userName, fetchGrantRow } from '../ui/grants.js';
// Phase 2 — reuse the sacramental master-detail shell + the generic cross-file linker
// for the per-(person, institution) personnel record panel (no fork).
import { renderSacramentalPanel, refreshActivePanel, chipHtml } from '../sacramental/panelShell.js';
import { linkRecords, unlinkRecords, getLinks, linkRowHtml } from '../sacramental/recordLinks.js';

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

// Personnel-file presentation per record type: the left-card TYPE CHIP (label +
// tone → an existing badge token) and the detail-header avatar icon. Keys match
// RECORD_META / the record_grants record_type values.
const RECORD_CHIP = {
  review:       { label: 'Evaluation',   tone: 'active',   icon: 'fa-clipboard-check' },
  self_report:  { label: 'Self-Report',  tone: 'neutral',  icon: 'fa-user-pen' },
  incident:     { label: 'Incident',     tone: 'urgent',   icon: 'fa-triangle-exclamation' },
  disciplinary: { label: 'Disciplinary', tone: 'pending',  icon: 'fa-gavel' },
  memo:         { label: 'Memo',         tone: 'complete', icon: 'fa-note-sticky' },
};

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
// Collapsed position ids. The tree renders FULLY EXPANDED by default (Rev 1):
// an id is open unless it is in this set. Manual collapses live only for the
// session — a refresh resets the module, so the tree re-opens fully.
const _collapsed = new Set();
let _selectedPosId = null;     // node selected in the org chart (drives the floating panel)
let _addMenuPosId = null;      // node whose "+ Add Position" sibling/child menu is open
let _escBound = false;         // one-time Escape-to-close keydown binding
let _ctx = null;               // built context (see buildContext)
let _insts = [];
let _people = [];              // all personnel (incl. inactive, for name lookup)
let _authUserId = null;        // current auth user id (record author + RLS mirror)
let _profilesByUser = new Map(); // auth user_id -> personnel_id (author names)
let _templates = [];           // review_templates rows (parish-scoped)
let _templatePositions = [];   // review_template_positions rows
let _builder = null;           // active template-builder working state
let _file = null;              // active personnel file context: { personId, institutionId, mode }
let _archiveCache = [];        // archived records currently shown in the super-admin Archive

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function canManageTabs() { return isSuperAdmin(); }
function canEditTree()   { return isAdmin(); }   // admin OR super_admin (legacy gate)
// Phase 3: structural edits (tree title/type/supervisor/+Add/move/delete/occupancy)
// are SUPER-ADMIN ONLY. Records authority is the two-axis subtree rule (roles.js).
function canStruct()      { return hrCanManageStructure(); }
function viewerPersonId() { return store.currentUserProfile?.personnel_id || null; }

// A self-report is a performance_review the SUBJECT authors about themselves. Built-in
// template (the builder/template integration is for managers' evaluations; self-reports
// use this fixed reflective structure).
const SELF_REPORT_TEMPLATE = [
  { id: 'sr_accomplishments', type: 'text', prompt: 'Key accomplishments this period' },
  { id: 'sr_challenges',      type: 'text', prompt: 'Challenges or obstacles' },
  { id: 'sr_goals',           type: 'text', prompt: 'Goals for the next period' },
  { id: 'sr_support',         type: 'text', prompt: 'Support or resources needed' },
];
// Display kind for a record (a self-report shows its own chip, but persists in the
// performance_reviews table — RECORD_META lookups still use r._type === 'review').
function chipKey(r) { return (r._type === 'review' && r.is_self_report) ? 'self_report' : r._type; }

function empBadge(v) {
  const c = EMP_COLOR[v] || { bg: '#EEE', fg: '#555' };
  return `<span style="font-size:10px;font-weight:600;padding:1px 6px;border-radius:3px;background:${c.bg};color:${c.fg};">${EMP_LABEL[v] || v}</span>`;
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

// ── Data ────────────────────────────────────────────────────────────────────

export async function loadHr() {
  const root = document.getElementById('hr-root');
  if (!root) return;
  // Layer 0: HR is open to anyone who is a node on an org tree (or super-admin),
  // not just admins. Authority WITHIN the panel is enforced per-node/per-file.
  if (!canAccessHr()) {
    root.innerHTML = '<div style="padding:2rem;color:#6B7280;font-size:13px;">You do not have access to Human Resources.</div>';
    return;
  }
  root.style.cssText = '';   // clear the Stage-1 stub centering
  root.innerHTML = '<div style="padding:1rem;"><span class="pulse"></span></div>';

  const [instRes, peopleRes, posRes, occRes] = await Promise.all([
    sb.from('institutions').select('*').order('sort_order').order('name'),
    sb.from('personnel').select('id,name,active').order('name'),
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
  // Backstop = the parish pastor: the current occupant of the Pastor/Rector position
  // (HR org tree), replacing the retired personnel.type === 'pastor' lookup.
  let pastorName = null;
  for (const pos of ctx.posById.values()) {
    if (/\b(pastor|rector)\b/i.test(pos.title || '')) {
      const occ = ctx.currentByPos.get(pos.id);
      if (occ && occ.length) { pastorName = ctx.personName(occ[0].person_id); break; }
    }
  }
  return { kind: 'pastor', name: pastorName || 'the Pastor', title: 'Pastor' };
}

// ── Render: panel shell + institution tabs ──────────────────────────────────

function render() {
  const root = document.getElementById('hr-root');
  if (!root) return;

  // Layer 0: a non-super-admin sees a tab only for institutions whose org tree they
  // are a current node on; super-admin sees every institution.
  const myInstIds = store.currentUserRoles?.hrInstitutionIds || [];
  const visibleInsts = isSuperAdmin() ? _insts : _insts.filter(i => myInstIds.includes(i.id));
  if (!visibleInsts.some(i => i.id === _activeInstId)) _activeInstId = visibleInsts[0]?.id || null;

  const tabs = visibleInsts.map((inst, i) => {
    const active = inst.id === _activeInstId;
    // Structural: reorder + rename are super-admin only (canManageTabs).
    const arrows = canManageTabs() ? `
      <span data-action="move-inst" data-inst-id="${inst.id}" data-dir="left"  title="Move left"  style="cursor:pointer;color:#9CA3AF;padding:0 2px;${i === 0 ? 'visibility:hidden;' : ''}">‹</span>
      <span data-action="move-inst" data-inst-id="${inst.id}" data-dir="right" title="Move right" style="cursor:pointer;color:#9CA3AF;padding:0 2px;${i === visibleInsts.length - 1 ? 'visibility:hidden;' : ''}">›</span>` : '';
    const gear = canManageTabs() ? `
      <span data-action="rename-inst" data-inst-id="${inst.id}" title="Rename institution" style="cursor:pointer;color:#9CA3AF;padding:0 2px;">⚙</span>` : '';
    const mgmt = arrows + gear;
    return `<div class="hr-tab" data-action="select-tab" data-inst-id="${inst.id}" style="
        display:inline-flex;align-items:center;gap:2px;padding:.5rem .85rem;cursor:pointer;white-space:nowrap;
        font-size:13px;font-family:'Inter',sans-serif;font-weight:${active ? '600' : '400'};
        color:${active ? 'var(--navy)' : '#6B7280'};border-bottom:2px solid ${active ? 'var(--cardinal)' : 'transparent'};margin-bottom:-1px;">
      <i class="fa-solid ${inst.icon || 'fa-building'}" style="font-size:12px;color:#8B1A2F;margin-right:5px;"></i>
      <span>${esc(inst.name)}</span>${mgmt}
    </div>`;
  }).join('');

  // Institutions (and their permanent root position) are created in the
  // directory's add-institution flow — HR consumes the list, never creates it.
  root.innerHTML = `
    <div style="padding:1.1rem 1.1rem 0;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0 0 1rem;">
        <h1 style="font-family:'Cormorant Garamond',Georgia,serif;font-size:22px;font-weight:700;color:var(--navy);margin:0;">Human Resources</h1>
        ${isSuperAdmin() ? `<div style="display:flex;gap:8px;">
          <button class="btn-secondary" data-action="open-archive">Archive</button>
          <button class="btn-secondary" data-action="open-templates">Review Templates</button>
        </div>` : ''}
      </div>
      <div style="display:flex;align-items:flex-end;gap:0;border-bottom:.5px solid var(--stone);margin-bottom:1.1rem;overflow-x:auto;">
        ${tabs || '<span style="font-size:13px;color:#6B7280;padding:.5rem 0;">No institutions yet.</span>'}
      </div>
      <div id="hr-tree"></div>
    </div>`;

  renderTree();

  // Single delegated handler for tabs + tree node actions (replaces on re-render).
  root.onclick = onHrClick;
  root.onchange = onHrChange;   // panel type select + supervisor checkbox

  // Escape closes the floating node panel (bound once, guards on selection).
  if (!_escBound) {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && _selectedPosId) { _selectedPosId = null; _addMenuPosId = null; renderTree(); }
    });
    _escBound = true;
  }
}

// ── PHASE 3 — tree render ───────────────────────────────────────────────────

function renderTree() {
  const el = document.getElementById('hr-tree');
  if (!el) return;
  if (!_activeInstId) { el.innerHTML = ''; return; }

  // Drop a stale selection (e.g. after a position was deleted).
  if (_selectedPosId && !_ctx.posById.get(_selectedPosId)) { _selectedPosId = null; _addMenuPosId = null; }

  const roots = _ctx.childrenByParent.get('__root__')?.filter(p => p.institution_id === _activeInstId) || [];

  // Family-tree-style org chart: one connected tree per institution root. Each node
  // is a rounded card (name + title, VACANT in red). The whole chart pans/scrolls
  // inside .org-scroll (works on desktop AND mobile); branches collapse via the
  // node toggle. Clicking a node opens a floating editor panel OVER the chart
  // (position:fixed, so it escapes the org-scroll overflow clip).
  const tree = roots.length
    ? `<div class="org-scroll"><div class="org-tree"><ul>${roots.map(renderNode).join('')}</ul></div></div>`
    : `<div class="card" style="padding:1rem 1.1rem;font-size:13px;color:#6B7280;font-style:italic;">This institution has no root position yet — it will be created automatically (or via the backfill migration).</div>`;

  el.innerHTML = tree + renderNodePanel();
  positionPop();   // anchor the floating panel near the selected node (desktop)
}

// Anchor the floating node panel near the clicked node on desktop; on mobile the
// panel is a centered bottom sheet (CSS-positioned), so leave its inline position
// unset. position:fixed means it floats above the org-scroll, never clipped.
function positionPop() {
  const pop = document.getElementById('org-pop');
  if (!pop || !_selectedPosId) return;
  if (window.innerWidth <= 767) { pop.style.left = ''; pop.style.top = ''; return; }
  const node = document.querySelector(`.org-node[data-pos-id="${CSS.escape(_selectedPosId)}"]`);
  if (!node) return;
  const r = node.getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 12, m = 8;
  let left = r.right + gap;                                  // prefer to the right of the node
  if (left + pw > window.innerWidth - m) left = r.left - pw - gap;   // flip to the left
  left = Math.max(m, Math.min(left, window.innerWidth - pw - m));
  let top = Math.min(r.top, window.innerHeight - ph - m);
  top = Math.max(m, top);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function renderNode(pos) {
  const children = _ctx.childrenByParent.get(pos.id) || [];
  const hasChildren = children.length > 0;
  const isOpen = !_collapsed.has(pos.id);
  const current = _ctx.currentByPos.get(pos.id) || [];
  const vacant = current.length === 0;
  const sel = pos.id === _selectedPosId ? ' sel' : '';

  const nameHtml = vacant
    ? `<div class="vac">VACANT</div>`
    : `<div class="nm">${esc(_ctx.personName(current[0].person_id))}${current.length > 1 ? `<span style="font-size:11px;color:#9CA3AF;font-weight:400;"> +${current.length - 1}</span>` : ''}</div>`;
  const sup = pos.is_administrator ? `<div class="sup">Supervisor</div>` : '';
  const toggle = hasChildren ? `<span class="org-toggle" data-action="toggle" data-pos-id="${pos.id}" title="${isOpen ? 'Collapse' : 'Expand'}">${isOpen ? '–' : '+'}</span>` : '';

  const node = `<div class="org-node${vacant ? ' vacant' : ''}${sel}" data-action="node" data-pos-id="${pos.id}">
      ${nameHtml}
      <div class="org-ti">${esc(pos.title)}</div>
      ${sup}
      ${toggle}
    </div>`;

  const kids = (hasChildren && isOpen) ? `<ul>${children.map(renderNode).join('')}</ul>` : '';
  return `<li>${node}${kids}</li>`;
}

// Inline editor for the selected node (Phase 1 mechanics under current HR access;
// Phase 3 applies the full permission model). Reuses the existing positions /
// person_positions persistence + the person link picker.
function renderNodePanel() {
  if (!_selectedPosId) return '';
  const pos = _ctx.posById.get(_selectedPosId);
  if (!pos) return '';
  const current = _ctx.currentByPos.get(pos.id) || [];
  const occ = current[0] || null;
  const vacant = !occ;
  const isRoot = !pos.parent_position_id;

  // Layer 3 gating. Structural edits (title/type/supervisor/+Add/move/delete/occupancy)
  // = super-admin only. The "View Personnel Record" button = the viewer has authority
  // over this person (supervisor-above or super-admin) OR it is their OWN node.
  const struct = canStruct();
  const vp = viewerPersonId();
  const targetPerson = occ?.person_id || null;
  const isOwn = !!(targetPerson && targetPerson === vp);
  const hasAuthority = !!(targetPerson && hrHasAuthority(vp, targetPerson, pos.institution_id, _ctx));
  const showRecordBtn = !!(targetPerson && (hasAuthority || isOwn));

  const occupantRow = vacant
    ? (struct
      ? `<label>Link a person</label>
         <div class="op-row">
           <select id="op-person" style="flex:1;min-width:150px;"><option value="">— Select person —</option>${personPickerOptions()}</select>
           <select id="op-link-type">${empTypeOptions('full_time')}</select>
           <button class="btn-primary" data-action="op-link" data-pos-id="${pos.id}" style="padding:.4rem .9rem;font-size:12.5px;">Link</button>
         </div>`
      : `<div style="font-size:13px;color:var(--cardinal);font-weight:600;">Vacant</div>`)
    : `<label>Employee${current.length > 1 ? 's' : ''}</label>
       <div class="op-row">
         ${current.map(o => `<span style="display:inline-flex;align-items:center;gap:6px;font-size:13.5px;color:var(--navy);font-weight:600;">${esc(_ctx.personName(o.person_id))} ${empBadge(o.employment_type)}${struct ? `<span data-action="op-unlink" data-occ-id="${o.id}" title="Unlink" style="cursor:pointer;color:#B45309;font-size:12px;">✕</span>` : ''}</span>`).join('')}
       </div>`;

  const titleRow = struct
    ? `<label>Position title</label>
       <div class="op-row">
         <input type="text" id="op-title" value="${esc(pos.title)}" style="flex:1;min-width:180px;" />
         <button class="btn-secondary" data-action="op-save-title" data-pos-id="${pos.id}" style="padding:.4rem .8rem;font-size:12.5px;">Save</button>
       </div>`
    : `<label>Position title</label><div style="font-size:13.5px;color:var(--navy);">${esc(pos.title)}</div>`;

  const typeRow = !occ ? ''
    : (struct
      ? `<label>Type</label>
         <select id="op-type" data-action="op-set-type" data-occ-id="${occ.id}" style="min-width:150px;">${empTypeOptions(occ.employment_type)}</select>`
      : `<label>Type</label><div>${empBadge(occ.employment_type)}</div>`);

  const supRow = struct
    ? `<label style="display:flex;align-items:center;gap:8px;margin-top:.75rem;cursor:pointer;">
        <input type="checkbox" id="op-sup" data-action="op-toggle-sup" data-pos-id="${pos.id}" ${pos.is_administrator ? 'checked' : ''} style="width:auto;margin:0;accent-color:var(--cardinal);" />
        <span style="font-size:13px;color:var(--navy);">Supervisor (supervises subordinate positions)</span>
      </label>`
    : '';   // supervisor status shows as the header chip when set (read-only)

  const addMenu = (_addMenuPosId === pos.id && struct)
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:.55rem;padding:.5rem .6rem;background:#F8F7F4;border-radius:6px;">
        ${isRoot ? '' : `<button class="btn-secondary" data-action="op-add-sibling" data-pos-id="${pos.id}" style="padding:.35rem .8rem;font-size:12.5px;">Add Sibling</button>`}
        <button class="btn-secondary" data-action="op-add-child" data-pos-id="${pos.id}" style="padding:.35rem .8rem;font-size:12.5px;">Add Child</button>
        ${isRoot ? `<span style="font-size:11.5px;color:#9CA3AF;align-self:center;">Root position — children only.</span>` : ''}
      </div>`
    : '';

  const recordBtn = showRecordBtn
    ? `<button class="btn-secondary" data-action="op-view-record" data-occ-id="${occ.id}" style="padding:.4rem .8rem;font-size:12.5px;">View Personnel Record</button>`
    : '';

  // Super-admin: full structural toolset + record button. Supervisor/own-node user:
  // only the record button. Regular employee on someone else's node: neither (locked).
  const footer = struct
    ? `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:.9rem;align-items:center;">
        ${recordBtn}
        <button class="btn-primary" data-action="op-add-toggle" data-pos-id="${pos.id}" style="padding:.4rem .8rem;font-size:12.5px;">+ Add Position</button>
        ${isRoot ? '' : `<button data-action="op-move" data-pos-id="${pos.id}" style="background:none;border:none;color:#8FA8BF;font-size:12px;cursor:pointer;">Move</button>`}
        ${isRoot ? '' : `<button data-action="op-delete" data-pos-id="${pos.id}" style="background:none;border:none;color:#A32D2D;font-size:12px;cursor:pointer;margin-left:auto;">Delete</button>`}
      </div>
      ${addMenu}`
    : (recordBtn ? `<div style="margin-top:.9rem;">${recordBtn}</div>` : '');

  return `<div class="org-pop-backdrop" data-action="op-close"></div>
    <div class="org-pop" id="org-pop" role="dialog" aria-modal="true">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
      <div style="font-family:'Cormorant Garamond',Georgia,serif;font-weight:700;font-size:17px;color:var(--navy);line-height:1.2;">${esc(pos.title)}${pos.is_administrator ? ` <span class="org-sup" style="vertical-align:middle;">Supervisor</span>` : ''}</div>
      <button data-action="op-close" title="Close" style="background:none;border:none;font-size:18px;color:#9CA3AF;cursor:pointer;line-height:1;flex-shrink:0;">×</button>
    </div>
    ${occupantRow}
    ${titleRow}
    ${typeRow}
    ${supRow}
    ${footer}
  </div>`;
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
    case 'open-templates': openTemplateManager(); break;
    case 'open-archive':   openHrArchive(); break;
    case 'toggle':      _collapsed.has(posId) ? _collapsed.delete(posId) : _collapsed.add(posId); renderTree(); break;
    // ── Org-chart node + inline panel ──────────────────────────────────────
    case 'node':        _selectedPosId = posId; _addMenuPosId = null; renderTree(); break;
    case 'op-close':    _selectedPosId = null; _addMenuPosId = null; renderTree(); break;
    case 'op-save-title': hrSetTitle(posId); break;
    case 'op-link':     hrLinkInline(posId); break;
    case 'op-unlink':   unlinkOccupancy(occId); break;
    case 'op-view-record': if (occId) openPersonnelFileFromOcc(occId); break;
    case 'file-back':   _selectedPosId = null; _addMenuPosId = null; _file = null;
                        if ((location.hash || '').startsWith('#/personnel')) location.hash = '';
                        render(); break;
    case 'pf-add-self':     hrPfAddSelfReport(); break;
    case 'pf-mark-departed': hrPfMarkDeparted(); break;
    case 'op-add-toggle': _addMenuPosId = (_addMenuPosId === posId ? null : posId); renderTree(); break;
    case 'op-add-sibling': hrAddPosition(_ctx.posById.get(posId)?.parent_position_id || null); break;
    case 'op-add-child': hrAddPosition(posId); break;
    case 'op-move':     openMoveModal(posId); break;
    case 'op-delete':   deletePosition(posId); break;
    // ── legacy actions (kept for the reused modals) ────────────────────────
    case 'add-child':   openPositionModal(null, posId); break;
    case 'edit-pos':    openPositionModal(posId, null); break;
    case 'move-pos':    openMoveModal(posId); break;
    case 'link':        openLinkModal(posId); break;
    case 'archive':     archivePosition(posId); break;
    case 'delete':      deletePosition(posId); break;
    case 'unlink':      unlinkOccupancy(occId); break;
  }
}

// Change delegate for the inline panel's select/checkbox (type + supervisor).
function onHrChange(e) {
  const t = e.target.closest('[data-action]');
  if (!t) return;
  if (t.dataset.action === 'op-set-type') hrSetType(t.dataset.occId, t.value);
  else if (t.dataset.action === 'op-toggle-sup') hrSetSupervisor(t.dataset.posId, t.checked);
}

// ── Inline-panel persistence (reuses the existing positions / person_positions model) ──
async function hrSetTitle(posId) {
  if (!canStruct()) return;
  const title = document.getElementById('op-title')?.value.trim();
  if (!title) { alert('Title is required.'); return; }
  const { error } = await sb.from('positions').update({ title, updated_at: new Date().toISOString() }).eq('id', posId);
  if (error) { alert('Save failed: ' + error.message); return; }
  logActivity({ action: 'updated position', entityType: 'position', entityName: title });
  window.flashSavedThen(async () => { await loadHr(); });
}
async function hrSetType(occId, type) {
  if (!canStruct() || !occId) return;
  const { error } = await sb.from('person_positions').update({ employment_type: type }).eq('id', occId);
  if (error) { alert('Update failed: ' + error.message); return; }
  await loadHr();
}
async function hrSetSupervisor(posId, checked) {
  if (!canStruct()) return;
  const { error } = await sb.from('positions').update({ is_administrator: !!checked, updated_at: new Date().toISOString() }).eq('id', posId);
  if (error) { alert('Update failed: ' + error.message); return; }
  await loadHr();
}
async function hrLinkInline(posId) {
  if (!canStruct()) return;
  const personId = document.getElementById('op-person')?.value;
  const empType  = document.getElementById('op-link-type')?.value || 'full_time';
  if (!personId) { alert('Select a person.'); return; }
  const { error } = await sb.from('person_positions').insert({ person_id: personId, position_id: posId, employment_type: empType });
  if (error) { alert('Link failed: ' + error.message); return; }
  logActivity({ action: 'linked person to position', entityType: 'person_position', entityName: _ctx.posById.get(posId)?.title || '' });
  window.flashSavedThen(async () => { await loadHr(); });
}
// "+ Add Position": create a VACANT position (sibling = same parent; child = under this).
async function hrAddPosition(parentId) {
  if (!canStruct()) return;
  const { data, error } = await sb.from('positions').insert({
    institution_id: _activeInstId, parent_position_id: parentId || null, title: 'New Position', is_administrator: false,
  }).select().single();
  if (error) { alert('Add failed: ' + error.message); return; }
  _addMenuPosId = null;
  if (parentId) _collapsed.delete(parentId);
  _selectedPosId = data?.id || null;   // select the new vacant node so it can be filled in
  logActivity({ action: 'created position', entityType: 'position', entityName: 'New Position' });
  await loadHr();
}

// ── PHASE 2 — institution add / rename / reorder (super-admin) ───────────────

function openModalHtml(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('open');
}

// Rename an existing institution. HR does not create institutions — that lives
// in the directory's add-institution flow (which also creates the root).
function openInstitutionModal(id) {
  if (!canManageTabs()) return;
  const inst = _insts.find(i => i.id === id);
  if (!inst) return;
  openModalHtml(`
    <div class="modal-title">Rename institution</div>
    <label>Name</label><input id="hr-inst-name" value="${esc(inst.name || '')}" placeholder="e.g. Cathedral School" />
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="window.hrSaveInstitution('${inst.id}')">Save</button>
    </div>`);
}

// HR renames existing institutions only — it never CREATES institutions or
// roots (the directory's institution-creation flow does, Revision 2).
async function hrSaveInstitution(id) {
  const name = document.getElementById('hr-inst-name').value.trim();
  if (!name) { alert('Name is required.'); return; }
  if (!id) { closeModal(); return; }
  const old = _insts.find(i => i.id === id);
  const { error } = await sb.from('institutions').update({ name }).eq('id', id);
  if (error) { alert('Save failed: ' + error.message); return; }
  // (No personnel.institution name-link to cascade — HR membership is keyed by id.)
  logActivity({ action: 'renamed institution', entityType: 'institution', entityName: name });
  window.flashSavedThen(async () => { closeModal(); await loadHr(); });
}

// Reorder by renumbering sort_order across all institutions in the new order.
async function reorderInstitution(id, dir) {
  if (!canStruct()) return;
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
  if (!canStruct()) return;
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
    if (parentId) _collapsed.delete(parentId);   // reveal the new child
  }
  logActivity({ action: posId ? 'updated position' : 'created position', entityType: 'position', entityName: title });
  window.flashSavedThen(async () => { closeModal(); await loadHr(); });
}

function openMoveModal(posId) {
  if (!canStruct()) return;
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
  if (newParent) _collapsed.delete(newParent);   // reveal the moved node
  window.flashSavedThen(async () => { closeModal(); await loadHr(); });
}

// ── PHASE 4 — occupancy link / unlink / contractor fast-add ─────────────────

function personPickerOptions(selectedId) {
  return _people.filter(p => p.active !== false)
    .slice()
    .sort((a, b) => compareByLastName(a.name, b.name))   // by last name, then given names
    .map(p => `<option value="${p.id}"${p.id === selectedId ? ' selected' : ''}>${esc(p.name)}</option>`)
    .join('');
}
function empTypeOptions(selected) {
  return EMP_TYPES.map(t => `<option value="${t.v}"${t.v === selected ? ' selected' : ''}>${t.label}</option>`).join('');
}

function openLinkModal(posId) {
  if (!canStruct()) return;
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
  _collapsed.delete(posId);   // reveal the position the person was linked to
  logActivity({ action: 'linked person to position', entityType: 'person_position', entityName: _ctx.posById.get(posId)?.title || '' });
  window.flashSavedThen(async () => { closeModal(); await loadHr(); });
}

async function unlinkOccupancy(occId) {
  if (!canStruct()) return;
  const occ = (_ctx.allByPos.get([..._ctx.allByPos.keys()].find(k => (_ctx.allByPos.get(k) || []).some(o => o.id === occId))) || [])
    .find(o => o.id === occId);
  const name = occ ? _ctx.personName(occ.person_id) : 'this person';
  if (!confirm(`Unlink ${name} from this position? Their record history is preserved; other positions are untouched.`)) return;
  const { error } = await sb.from('person_positions').update({ unlinked_at: new Date().toISOString() }).eq('id', occId);
  if (error) { alert('Unlink failed: ' + error.message); return; }
  logActivity({ action: 'unlinked person from position', entityType: 'person_position', entityName: name });
  await loadHr();
}

// (Contractor fast-add removed — Revision 1. Contractors are added like any
// position: + Child, then link a person with employment-type "Contract".)

// ── PHASE 4 — removal rules (archive vs hard-delete) ────────────────────────

async function archivePosition(posId) {
  if (!canStruct()) return;
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
  if (!canStruct()) return;
  const pos = _ctx.posById.get(posId);
  if (!pos) return;
  // The permanent root is never deletable.
  if (!pos.parent_position_id) {
    alert('The institution’s permanent root position cannot be deleted.');
    return;
  }
  // Any occupancy ever (current OR historical) → archive-only, never hard-delete
  // (preserves record provenance — records FK to person_position_id).
  if ((_ctx.allByPos.get(posId) || []).length) {
    alert('This position has occupancy history and cannot be deleted — archive it instead to preserve record provenance.');
    return;
  }
  // Reparent children to the deleted node's PARENT — never orphan a node.
  const children = _ctx.childrenByParent.get(posId) || [];
  const parent = _ctx.posById.get(pos.parent_position_id);
  const parentTitle = parent ? parent.title : 'the parent position';
  let msg = `Delete “${pos.title}”?`;
  if (children.length) {
    msg += `\n\n${children.length} position${children.length > 1 ? 's' : ''} will move under “${parentTitle}”:\n• ${children.map(c => c.title).join('\n• ')}`;
  }
  if (!confirm(msg)) return;
  if (children.length) {
    const { error: rErr } = await sb.from('positions')
      .update({ parent_position_id: pos.parent_position_id, updated_at: new Date().toISOString() })
      .in('id', children.map(c => c.id));
    if (rErr) { alert('Reparent failed: ' + rErr.message); return; }
  }
  const { error } = await deleteWithRetry(() => sb.from('positions').delete().eq('id', posId));
  if (error) { alert('Delete failed: ' + error.message); return; }
  logActivity({ action: 'deleted position', entityType: 'position', entityName: pos.title });
  await loadHr();
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

  // Person line: (person, institution)-scoped records carry person_id directly;
  // legacy occupancy-scoped records fall back to the person_position label.
  const who = rec.person_id ? esc(_ctx.personName(rec.person_id)) : labelForPP(rec.person_position_id);
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
async function fetchRecord(type, id) {
  const { data } = await sb.from(RECORD_META[type].table).select('*').eq('id', id).maybeSingle();
  return data;
}
function labelForPP(ppId) {
  for (const [pid, list] of _ctx.allByPos) {
    const o = list.find(x => x.id === ppId);
    if (o) { const pos = _ctx.posById.get(pid); return esc(_ctx.personName(o.person_id)) + (pos ? ' — ' + esc(pos.title) : ''); }
  }
  return 'Record';
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

function renderAnswer(f, a) {
  if (a === null || a === undefined || a === '') return '<span style="color:#9CA3AF;">—</span>';
  return esc(String(a));
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
  await deleteWithRetry(() => sb.from('review_template_positions').delete().eq('template_id', id));
  const { error } = await deleteWithRetry(() => sb.from('review_templates').delete().eq('id', id));
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
  await deleteWithRetry(() => sb.from('review_template_positions').delete().eq('template_id', templateId));
  const ids = [..._builder.positionIds];
  if (ids.length) {
    await sb.from('review_template_positions').insert(ids.map(pid => ({ template_id: templateId, position_id: pid })));
  }
  logActivity({ action: _builder.id ? 'updated review template' : 'created review template', entityType: 'review_template', entityName: name });
  _builder = null;
  window.flashSavedThen(async () => { await refreshTemplates(); openTemplateManager(); });
}

// ════════════════════════════════════════════════════════════════════════════
// PHASE 2 — PERSONNEL RECORD PANEL  (per-PERSON-per-INSTITUTION file)
// Reuses the sacramental master-detail shell (renderSacramentalPanel) for the
// left card column + read viewer, the chip pattern, and the generic record_links
// cross-file linker. Records key to (person_id, institution_id) — independent of
// any single occupancy, so all of a person's records at one institution (across
// however many positions) share ONE file. Permission enforcement = Phase 3.
// ════════════════════════════════════════════════════════════════════════════

// Creation date (uneditable) as MM/DD/YYYY in the PARISH timezone. created_at is a
// UTC timestamp; a naive ISO slice can roll to the next day in CST, so convert in-tz.
function createdMDY(ts) {
  if (!ts) return '';
  const tz = store.parishSettings?.timezone || 'America/Chicago';
  try { return new Date(ts).toLocaleDateString('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); }
  catch { return formatDateMDY(String(ts).slice(0, 10)); }
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

// The person's CURRENT position titles in THIS institution (one file may span
// several positions — show them all).
function personTitlesIn(personId, institutionId) {
  const titles = [];
  for (const [posId, list] of _ctx.currentByPos) {
    if (!list.some(o => o.person_id === personId)) continue;
    const pos = _ctx.posById.get(posId);
    if (pos && pos.institution_id === institutionId) titles.push(pos.title);
  }
  return [...new Set(titles)].sort((a, b) => a.localeCompare(b));
}

// Entry point from a node's "View Personnel Record" button (occId → person).
function openPersonnelFileFromOcc(occId) {
  let personId = null;
  for (const list of _ctx.allByPos.values()) {
    const o = list.find(x => x.id === occId);
    if (o) { personId = o.person_id; break; }
  }
  if (personId) openPersonnelFile(personId, _activeInstId);
}

// Replace the HR panel body with the personnel file (its own panel, like a
// sacramental panel): person header + the reused master-detail shell.
function openPersonnelFile(personId, institutionId) {
  if (!_ctx) return;
  // Layer 3: management (super-admin OR a supervisor above this person) vs OWN file.
  // On your OWN file you are an EMPLOYEE (self-report), even if you're a supervisor
  // elsewhere. Access is guarded here too (the launching button is already gated).
  const vp = viewerPersonId();
  const own = !!(vp && personId === vp);
  const manage = hrHasAuthority(vp, personId, institutionId, _ctx);
  if (!own && !manage) return;
  // OWN file always wins: on your own file you are the EMPLOYEE (self-report), even
  // if you're a supervisor/super-admin — you don't manage your own records.
  const mode = own ? 'own' : 'manage';
  _file = { personId, institutionId, mode };
  const root = document.getElementById('hr-root');
  if (!root) return;
  const name = _ctx.personName(personId);
  const titles = personTitlesIn(personId, institutionId);
  const instName = _insts.find(i => i.id === institutionId)?.name || '';
  // Own file → "Add self report" (employee). Super-admin → archive a departed file.
  const selfBtn = mode === 'own' ? `<button class="btn-primary" data-action="pf-add-self" style="padding:.4rem .8rem;font-size:12.5px;white-space:nowrap;">+ Add self report</button>` : '';
  const departBtn = (mode === 'manage' && isSuperAdmin()) ? `<button class="btn-secondary" data-action="pf-mark-departed" style="padding:.4rem .8rem;font-size:12.5px;white-space:nowrap;">Archive (departed)</button>` : '';
  root.innerHTML = `
    <div class="pf-head">
      <button class="pf-back" data-action="file-back" aria-label="Back to org chart"><i class="fa-solid fa-arrow-left"></i> Org chart</button>
      <div class="pf-id">
        <div class="pf-avatar">${esc(initialsOf(name))}</div>
        <div>
          <div class="pf-name">${esc(name)}</div>
          <div class="pf-titles">${titles.length ? esc(titles.join(' · ')) : '<span style="color:#9CA3AF;">No current position</span>'}${instName ? ` <span style="color:#9CA3AF;">· ${esc(instName)}</span>` : ''}</div>
        </div>
      </div>
      ${selfBtn || departBtn ? `<div style="margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;">${selfBtn}${departBtn}</div>` : ''}
    </div>
    <div id="pf-host" class="pf-host"></div>`;
  // Reset the shell's deep-link hash before mounting so a stale id doesn't preselect.
  if ((location.hash || '') !== '#/personnel') location.hash = '#/personnel';
  renderSacramentalPanel(document.getElementById('pf-host'), personnelFileConfig(personId, institutionId));
}

// Merge the four record tables for (person, institution); tag each with its type;
// order chronologically by creation. RLS scopes the result (Phase 3 widens this).
async function fetchPersonnelRecords(personId, institutionId) {
  // Live file = non-archived records (deleted records live only in the super-admin archive).
  const q = (table) => sb.from(table).select('*').eq('person_id', personId).eq('institution_id', institutionId).is('archived_at', null);
  const [rev, dis, inc, mem] = await Promise.all([
    q('performance_reviews'), q('disciplinary_records'), q('incident_reports'), q('memos'),
  ]);
  const tag = (res, type) => (res.data || []).map(r => ({ ...r, _type: type }));
  return [...tag(rev, 'review'), ...tag(dis, 'disciplinary'), ...tag(inc, 'incident'), ...tag(mem, 'memo')]
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

function recordSnippet(r) {
  if (r._type === 'memo')         return r.subject || String(r.body || '').slice(0, 64) || 'Memo';
  if (r._type === 'incident')     return String(r.description || '').slice(0, 64) || 'Incident report';
  if (r._type === 'disciplinary') return (r.severity ? r.severity.toUpperCase() + ' — ' : '') + (String(r.narrative || '').slice(0, 52) || 'Disciplinary action');
  return 'Performance evaluation';
}

// The sacramental-shell config for one personnel file. `cache` mirrors the shell's
// fetched records so fetchRecord/save/delete can resolve a record's _type by id.
function personnelFileConfig(personId, institutionId) {
  let cache = [];
  return {
    panelKey: 'personnel',
    title: 'Personnel Record',
    newLabel: '+ Create new entry',
    // Management mode → the shell's New/Edit/Delete (manager records). Own mode →
    // read-only; the employee's self-report is handled by per-record controls.
    canManage: () => _file?.mode === 'manage',
    fetchRecords: async () => { cache = await fetchPersonnelRecords(personId, institutionId); return cache; },
    fetchRecord: (id) => cache.find(r => r.id === id) || null,
    compare: (a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')),
    searchText: (r) => `${RECORD_CHIP[chipKey(r)].label} ${createdMDY(r.created_at)} ${recordSnippet(r)}`,
    listItem: (r) => ({
      title: createdMDY(r.created_at),
      secondary: recordSnippet(r),
      chips: [{ label: RECORD_CHIP[chipKey(r)].label, tone: RECORD_CHIP[chipKey(r)].tone }],
    }),
    detailHeader: (r) => ({
      name: RECORD_CHIP[chipKey(r)].label,
      avatarIcon: RECORD_CHIP[chipKey(r)].icon,
      chips: [{ label: `Created ${createdMDY(r.created_at)}`, tone: 'neutral' }],
    }),
    detailSections: [
      { title: 'Details', render: (r) => recordDetailHtml(r) },
      { title: 'Linked records', render: (r) => linkedSectionHtml(r) },
    ],
    actions: [
      { label: 'Export PDF', icon: 'fa-file-pdf', handler: (r) => hrExportPdf(r._type, r.id) },
    ],
    editForm: (r) => recordEditForm(r),
    saveRecord: async (id) => ({ ok: await savePersonnelRecord(cache.find(r => r.id === id)) }),
    deleteRecord: async (id) => ({ ok: await deletePersonnelRecord(cache.find(r => r.id === id)) }),
    openCreate: () => hrPfCreate(),
  };
}

// ── Read viewer (detail) ─────────────────────────────────────────────────────
function recordDetailHtml(r) {
  const isSelf = r._type === 'review' && r.is_self_report;
  const meta = `<div style="font-size:11.5px;color:#6B7280;margin-bottom:.8rem;">Created ${createdMDY(r.created_at)} · ${esc(authorName(r.author_id))}${r.record_date ? ' · dated ' + formatDateMDY(r.record_date) : ''}</div>`;
  const banner = `<div style="font-size:10.5px;color:#B9A88F;font-style:italic;border-top:.5px solid var(--stone);margin-top:1rem;padding-top:.55rem;line-height:1.5;">${esc(bannerText())}</div>`;
  const controls = recordControlsHtml(r);
  if (r._type === 'memo') {
    return meta
      + (r.subject ? `<div style="font-weight:600;color:var(--navy);margin-bottom:.3rem;">${esc(r.subject)}</div>` : '')
      + `<div style="font-size:13.5px;color:#374151;line-height:1.6;white-space:pre-wrap;">${esc(r.body || '')}</div>` + controls;
  }
  if (r._type === 'incident') {
    return meta + `<div style="font-size:13.5px;color:#374151;line-height:1.6;white-space:pre-wrap;">${esc(r.description || '')}</div>` + banner + controls;
  }
  if (r._type === 'disciplinary') {
    const field = (l, v) => v ? `<div class="pf-flabel">${l}</div><div class="pf-fval">${esc(v)}</div>` : '';
    const sev = r.severity ? `<div style="margin-bottom:.7rem;"><span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:3px;background:#FDEAED;color:#8B1A2F;">${esc(r.severity.toUpperCase())}</span></div>` : '';
    const signed = r.signed_on_file
      ? `<div style="font-size:12px;color:#2E6B43;">✓ Signed physical copy on file${r.signed_date ? ` (${formatDateMDY(r.signed_date)})` : ''}</div>`
      : `<div style="font-size:12px;color:#9CA3AF;">Signed copy not yet on file</div>`;
    return meta + sev + field('Narrative', r.narrative) + field('Corrective action', r.corrective_action) + signed + banner + controls;
  }
  // review / self-report
  const status = isSelf
    ? (r.finalized
        ? `<div style="font-size:12px;color:#2E6B43;margin-bottom:.6rem;"><i class="fa-solid fa-lock" style="margin-right:4px;"></i>Finalized${r.finalized_at ? ' ' + createdMDY(r.finalized_at) : ''}${r.finalized_by ? ' · by ' + esc(authorName(r.finalized_by)) : ''} — locked</div>`
        : `<div style="font-size:12px;color:#9A6A1E;margin-bottom:.6rem;">Draft — editable by ${esc(authorName(r.author_id))} until a supervisor finalizes it.</div>`)
    : '';
  const def = Array.isArray(r.frozen_definition) ? r.frozen_definition : [];
  const ans = r.answers || {};
  const period = (r.review_period_start || r.review_period_end)
    ? `<div style="font-size:12px;color:#6B7280;margin-bottom:.5rem;">Period: ${r.review_period_start ? formatDateMDY(r.review_period_start) : '…'} – ${r.review_period_end ? formatDateMDY(r.review_period_end) : '…'}</div>` : '';
  const rows = def.map(f => `
    <div style="padding:.4rem 0;border-bottom:.5px solid #F0EDE8;">
      <div style="font-size:12px;color:#6B7280;margin-bottom:1px;">${esc(f.prompt || '')}</div>
      <div style="font-size:13.5px;color:var(--navy);font-weight:500;">${renderAnswer(f, ans[f.id])}</div>
    </div>`).join('');
  const signed = r.signed_on_file
    ? `<div style="font-size:12px;color:#2E6B43;margin-top:.6rem;">✓ Signed physical copy on file${r.signed_date ? ` (${formatDateMDY(r.signed_date)})` : ''}</div>` : '';
  const emptyMsg = isSelf ? 'Empty self-report.' : 'Empty — use Edit to fill this evaluation in.';
  return meta + status + period + (rows || `<div style="font-size:12.5px;color:#9CA3AF;">${emptyMsg}</div>`) + signed + banner + controls;
}

// Per-record conditional controls (rendered inside the read viewer, fully gated by
// mode + record). Self-reports only: manager FINALIZE, or the author EDIT/DELETE
// until finalized. (Manager records use the shell's New/Edit/Delete; own-mode files
// are otherwise read-only.)
function recordControlsHtml(r) {
  if (!(r._type === 'review' && r.is_self_report)) return '';
  const vp = viewerPersonId();
  const btns = [];
  if (!r.finalized && _file?.mode === 'manage' && hrCanFinalizeSelfReport(vp, _file.personId, _file.institutionId, _ctx)) {
    btns.push(`<button class="btn-primary" style="padding:.35rem .85rem;font-size:12.5px;" onclick="window.hrPfFinalize('${r.id}')">Finalize self-report</button>`);
  }
  if (!r.finalized && _file?.mode === 'own' && r.author_id === _authUserId) {
    btns.push(`<button class="btn-secondary" style="padding:.35rem .85rem;font-size:12.5px;" onclick="window.hrPfEditSelfReport('${r.id}')">Edit</button>`);
    btns.push(`<button style="background:none;border:none;color:#A32D2D;font-size:12px;cursor:pointer;" onclick="window.hrPfArchiveOwn('${r.id}')">Delete</button>`);
  }
  return btns.length ? `<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:.9rem;">${btns.join('')}</div>` : '';
}

// ── Cross-file linking (generic record_links + the shared linked-row format) ──
function linkedSectionHtml(r) {
  if (typeof window !== 'undefined') setTimeout(() => populatePfLinks(r._type, r.id), 0);
  const picker = _file?.mode === 'manage'
    ? `<button class="card-action" style="margin-top:.55rem;" onclick="window.hrPfOpenLinkPicker('${r._type}','${r.id}')">+ Link a record</button>` : '';
  return `<div id="pf-links-${esc(r.id)}"><div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">Loading…</div></div>${picker}`;
}
async function populatePfLinks(type, id) {
  const wrap = document.getElementById(`pf-links-${id}`);
  if (!wrap) return;
  const ends = (await getLinks(type, id)).filter(e => RECORD_META[e.type]);
  if (!ends.length) { wrap.innerHTML = `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No linked records.</div>`; return; }
  const byType = {}; ends.forEach(e => { (byType[e.type] ||= []).push(e.id); });
  const rowByKey = {};
  for (const t of Object.keys(byType)) {
    const { data } = await sb.from(RECORD_META[t].table).select('*').in('id', byType[t]).is('archived_at', null);
    (data || []).forEach(row => { rowByKey[`${t}:${row.id}`] = row; });
  }
  const canManage = _file?.mode === 'manage';
  wrap.innerHTML = ends.map(e => {
    const row = rowByKey[`${e.type}:${e.id}`]; if (!row) return '';   // skips archived/missing
    const ck = chipKey(row);
    const title = `${RECORD_CHIP[ck].label} · ${createdMDY(row.created_at)}`;
    const chips = chipHtml({ label: RECORD_CHIP[ck].label, tone: RECORD_CHIP[ck].tone });
    const openCall = `location.hash='#/personnel/${e.id}'`;   // select in this same file
    const unlinkCall = canManage ? `window.hrPfUnlink('${type}','${id}','${e.type}','${e.id}')` : '';
    return linkRowHtml({ openCall, title: esc(title), chipsHtml: chips, unlinkCall });
  }).join('') || `<div style="font-size:12.5px;color:#9CA3AF;font-style:italic;">No linked records.</div>`;
}
// Picker = this person's OTHER records in this institution of a DIFFERENT type
// (the record_links mechanism forbids same-type pairs), not already linked.
async function hrPfOpenLinkPicker(type, id) {
  if (!_file || _file.mode !== 'manage') return;
  const [all, ends] = await Promise.all([
    fetchPersonnelRecords(_file.personId, _file.institutionId),
    getLinks(type, id),
  ]);
  const linked = new Set(ends.map(e => `${e.type}:${e.id}`));
  const candidates = all.filter(r => r._type !== type && !linked.has(`${r._type}:${r.id}`));
  const opts = candidates.map(r => `<option value="${r._type}:${r.id}">${esc(RECORD_CHIP[chipKey(r)].label)} · ${esc(createdMDY(r.created_at))} — ${esc(recordSnippet(r))}</option>`).join('');
  openModalHtml(`
    <div class="modal-title">Link a record</div>
    ${candidates.length
      ? `<label>Choose a record to link</label><select id="pf-link-target">${opts}</select>
         <div style="font-size:11.5px;color:#9CA3AF;margin-top:.4rem;">Links are reciprocal — they show on both files.</div>`
      : `<div style="font-size:13px;color:#6B7280;">No other records of a different type are available to link.</div>`}
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      ${candidates.length ? `<button class="btn-primary" onclick="window.hrPfDoLink('${type}','${id}')">Link</button>` : ''}
    </div>`);
}
async function hrPfDoLink(type, id) {
  const v = val('pf-link-target');
  if (!v) return;
  const [t2, id2] = v.split(':');
  if (await linkRecords(type, id, t2, id2)) { closeModal(); populatePfLinks(type, id); }
}
async function hrPfUnlink(type, id, t2, id2) {
  if (await unlinkRecords(type, id, t2, id2)) populatePfLinks(type, id);
}

// ── Create new entry (type picker → seeded insert → open in the shell) ───────
function hrPfCreate() {
  if (!_file || _file.mode !== 'manage') return;
  const btn = (type, emoji, label) => `<button class="btn-secondary" style="text-align:left;width:100%;display:flex;align-items:center;gap:8px;" onclick="window.hrPfNew('${type}')"><i class="fa-solid ${RECORD_CHIP[type].icon}" style="color:var(--cardinal);width:16px;"></i> ${label}</button>`;
  openModalHtml(`
    <div class="modal-title">Create new entry</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:.3rem;">
      ${btn('review', '', 'Personnel Evaluation')}
      ${btn('incident', '', 'Incident Report')}
      ${btn('disciplinary', '', 'Disciplinary Action')}
      ${btn('memo', '', 'Memo')}
    </div>
    <div class="modal-actions"><button class="btn-secondary" onclick="closeModal()">Cancel</button></div>`);
}
async function hrPfNew(type) {
  if (!_file) return;
  if (type === 'review') { hrPfPickReviewTemplate(); return; }
  await hrPfInsert(type, {});
}
// Evaluations need a frozen template structure at insert — offer templates assigned
// to this person's position(s) here, else any template, else a starter library item.
function hrPfPickReviewTemplate() {
  const posIds = [...(_ctx.currentByPos)]
    .filter(([pid, list]) => list.some(o => o.person_id === _file.personId) && _ctx.posById.get(pid)?.institution_id === _file.institutionId)
    .map(([pid]) => pid);
  const assignedIds = new Set(_templatePositions.filter(tp => posIds.includes(tp.position_id)).map(tp => tp.template_id));
  let choices = _templates.filter(t => assignedIds.has(t.id));
  if (!choices.length) choices = _templates.slice();
  const tmplBtns = choices.map(t => `<button class="btn-secondary" style="text-align:left;width:100%;" onclick="window.hrPfNewReviewTemplate('${t.id}')">${esc(t.name)}</button>`).join('');
  const starterBtns = STARTER_TEMPLATES.map((s, i) => `<button class="btn-secondary" style="text-align:left;width:100%;" onclick="window.hrPfNewReviewStarter(${i})">${esc(s.name)} <span style="color:#9CA3AF;font-size:11px;">· starter</span></button>`).join('');
  openModalHtml(`
    <div class="modal-title">New Personnel Evaluation</div>
    <div style="font-size:12px;color:#6B7280;margin-bottom:.6rem;">Choose a template — its structure is frozen into this evaluation. (Template management lives under <strong>Review Templates</strong>.)</div>
    <div style="display:flex;flex-direction:column;gap:6px;">
      ${tmplBtns}
      ${tmplBtns && starterBtns ? '<div style="height:1px;background:var(--stone);margin:.35rem 0;"></div>' : ''}
      ${starterBtns}
    </div>
    <div class="modal-actions"><button class="btn-secondary" onclick="closeModal()">Cancel</button></div>`);
}
function hrPfNewReviewTemplate(tid) {
  const t = _templates.find(x => x.id === tid);
  hrPfInsertReview(t?.definition || [], tid);
}
function hrPfNewReviewStarter(i) { hrPfInsertReview(STARTER_TEMPLATES[i].definition, null); }
function hrPfInsertReview(definition, templateId) {
  const frozen = JSON.parse(JSON.stringify((definition || []).map(f => ({ ...f, id: f.id || genId() }))));
  return hrPfInsert('review', { frozen_definition: frozen, template_id: templateId, review_date: todayISO() });
}
async function hrPfInsert(type, extra) {
  const base = {
    person_id: _file.personId, institution_id: _file.institutionId,
    author_id: _authUserId, record_date: todayISO(), ...extra,
  };
  const { data, error } = await withWriteRetry(() => sb.from(RECORD_META[type].table).insert(base).select('id').single(), { kind: 'create' });
  if (error) { alert('Create failed: ' + error.message); return; }
  closeModal();
  logActivity({ action: `created ${RECORD_META[type].label.toLowerCase()}`, entityType: 'hr_record', entityName: RECORD_META[type].label });
  await refreshActivePanel();
  location.hash = `#/personnel/${data.id}`;   // open the new (empty) file in the read viewer
}

// ── Inline edit (the shell's edit pane) + save / delete ──────────────────────
function recordEditForm(r) {
  // Self-reports are authored + edited by the EMPLOYEE on their own file; a manager
  // finalizes (read view), never edits the content here.
  if (r._type === 'review' && r.is_self_report) {
    return `<div style="font-size:13px;color:#6B7280;line-height:1.6;">This is the employee’s self-report. ${r.finalized ? 'It is finalized and locked.' : 'You can finalize it from the read view, but its content is edited by the employee.'}</div>`;
  }
  if (r._type === 'memo') {
    return `
      <label>Subject</label><input id="pf-memo-subject" value="${esc(r.subject || '')}" />
      <label>Body</label><textarea id="pf-memo-body" rows="6">${esc(r.body || '')}</textarea>
      <label>Date</label><input type="date" id="pf-memo-date" value="${r.record_date || todayISO()}" />`;
  }
  if (r._type === 'incident') {
    return `
      <label>Description</label><textarea id="pf-inc-desc" rows="7">${esc(r.description || '')}</textarea>
      <label>Date</label><input type="date" id="pf-inc-date" value="${r.record_date || todayISO()}" />`;
  }
  if (r._type === 'disciplinary') {
    const ladder = severityLadder();
    const sevOpts = ['<option value="">— Select —</option>']
      .concat(ladder.map(s => `<option value="${esc(s)}"${r.severity === s ? ' selected' : ''}>${esc(s.charAt(0).toUpperCase() + s.slice(1))}</option>`)).join('');
    return `
      <label>Narrative</label><textarea id="pf-dis-narr" rows="5">${esc(r.narrative || '')}</textarea>
      <label>Severity</label><select id="pf-dis-sev">${sevOpts}</select>
      <label>Corrective action</label><textarea id="pf-dis-corr" rows="3">${esc(r.corrective_action || '')}</textarea>
      <label>Date</label><input type="date" id="pf-dis-date" value="${r.record_date || todayISO()}" />
      <label style="display:flex;align-items:center;gap:8px;margin-top:.6rem;cursor:pointer;">
        <input type="checkbox" id="pf-dis-signed" ${r.signed_on_file ? 'checked' : ''} style="width:auto;margin:0;" onchange="document.getElementById('pf-dis-signedwrap').style.display=this.checked?'':'none'" />
        <span>Signed physical copy on file</span></label>
      <div id="pf-dis-signedwrap" style="display:${r.signed_on_file ? '' : 'none'};">
        <label>Signed date</label><input type="date" id="pf-dis-signeddate" value="${r.signed_date || ''}" /></div>`;
  }
  // review — answer fields from the frozen snapshot (reuses fieldInput)
  const def = Array.isArray(r.frozen_definition) ? r.frozen_definition : [];
  const ans = r.answers || {};
  const fields = def.map(f => fieldInput(f, ans[f.id])).join('');
  return `
    <div style="font-size:12px;color:#6B7280;margin-bottom:.6rem;">Structure frozen at creation.</div>
    ${fields || '<div style="font-size:12.5px;color:#9CA3AF;">This evaluation’s template has no fields.</div>'}
    <div style="border-top:.5px solid var(--stone);margin:.6rem 0;padding-top:.6rem;"></div>
    <div style="display:flex;gap:10px;">
      <div style="flex:1;"><label>Period start</label><input type="date" id="hr-rev-start" value="${r.review_period_start || ''}" /></div>
      <div style="flex:1;"><label>Period end</label><input type="date" id="hr-rev-end" value="${r.review_period_end || ''}" /></div>
    </div>
    <label>Review date</label><input type="date" id="hr-rev-date" value="${r.review_date || todayISO()}" />
    <label style="display:flex;align-items:center;gap:8px;margin-top:.6rem;cursor:pointer;">
      <input type="checkbox" id="hr-rev-signed" ${r.signed_on_file ? 'checked' : ''} style="width:auto;margin:0;" onchange="document.getElementById('hr-rev-signedwrap').style.display=this.checked?'':'none'" />
      <span>Signed physical copy on file</span></label>
    <div id="hr-rev-signedwrap" style="display:${r.signed_on_file ? '' : 'none'};">
      <label>Signed date</label><input type="date" id="hr-rev-signeddate" value="${r.signed_date || ''}" /></div>`;
}

async function savePersonnelRecord(r) {
  if (!r) return false;
  if (_file?.mode !== 'manage') return false;   // only managers use the shell edit
  if (r._type === 'review' && r.is_self_report) { alert('Self-reports are edited by the employee on their own file.'); return false; }
  const type = r._type;
  let fields;
  if (type === 'memo') {
    fields = { subject: val('pf-memo-subject').trim() || null, body: val('pf-memo-body').trim() || null, record_date: val('pf-memo-date') || null };
  } else if (type === 'incident') {
    fields = { description: val('pf-inc-desc').trim() || null, record_date: val('pf-inc-date') || null };
  } else if (type === 'disciplinary') {
    const signed = checked('pf-dis-signed');
    fields = {
      narrative: val('pf-dis-narr').trim() || null,
      severity: val('pf-dis-sev') || null,
      corrective_action: val('pf-dis-corr').trim() || null,
      record_date: val('pf-dis-date') || null,
      signed_on_file: signed,
      signed_date: signed ? (val('pf-dis-signeddate') || null) : null,
    };
  } else {
    const def = Array.isArray(r.frozen_definition) ? r.frozen_definition : [];
    const answers = {};
    for (const f of def) {
      const aid = `hr-ans-${f.id}`;
      if (f.type === 'numeric') {
        if (f.allow_na && checked(`hr-na-${f.id}`)) { answers[f.id] = 'N/A'; continue; }
        const raw = val(aid);
        if (raw === '') { answers[f.id] = null; continue; }
        const n = parseInt(raw, 10);
        if (Number.isNaN(n) || n < f.min || n > f.max) { alert(`“${f.prompt}” must be a whole number from ${f.min} to ${f.max}.`); return false; }
        answers[f.id] = n;
      } else {
        answers[f.id] = val(aid) || null;
      }
    }
    const signed = checked('hr-rev-signed');
    fields = {
      answers,
      review_period_start: val('hr-rev-start') || null,
      review_period_end: val('hr-rev-end') || null,
      review_date: val('hr-rev-date') || null,
      record_date: val('hr-rev-date') || r.record_date || todayISO(),
      signed_on_file: signed,
      signed_date: signed ? (val('hr-rev-signeddate') || null) : null,
    };
  }
  const { error } = await withWriteRetry(() => sb.from(RECORD_META[type].table).update({ ...fields, updated_at: nowIso() }).eq('id', r.id), { kind: 'update' });
  if (error) { alert('Save failed: ' + error.message); return false; }
  logActivity({ action: `updated ${RECORD_META[type].label.toLowerCase()}`, entityType: 'hr_record', entityName: RECORD_META[type].label });
  return true;
}

// Manager delete = SOFT delete to the super-admin archive (never hard-deleted here;
// records stay recoverable/auditable). Cross-file links are kept (they resolve only
// to non-archived records, so an archived file's links simply stop showing).
async function deletePersonnelRecord(r) {
  if (!r) return false;
  if (_file?.mode !== 'manage') return false;
  const label = RECORD_META[r._type].label.toLowerCase();
  if (!confirm(`Delete this ${label}? It moves to the archive (super-admin only) and leaves this file.`)) return false;
  const { error } = await withWriteRetry(() => sb.from(RECORD_META[r._type].table).update({ archived_at: nowIso() }).eq('id', r.id), { kind: 'update' });
  if (error) { alert('Delete failed: ' + error.message); return false; }
  logActivity({ action: `archived ${label}`, entityType: 'hr_record', entityName: RECORD_META[r._type].label });
  return true;
}

// ── Self-report (own file): add / edit / delete until finalized; finalize (manager) ──
async function hrPfAddSelfReport() {
  if (!_file || _file.mode !== 'own') return;
  const frozen = JSON.parse(JSON.stringify(SELF_REPORT_TEMPLATE));
  const base = {
    person_id: _file.personId, institution_id: _file.institutionId, author_id: _authUserId,
    record_date: todayISO(), review_date: todayISO(), is_self_report: true, frozen_definition: frozen,
  };
  const { data, error } = await withWriteRetry(() => sb.from('performance_reviews').insert(base).select('id').single(), { kind: 'create' });
  if (error) { alert('Create failed: ' + error.message); return; }
  logActivity({ action: 'created self report', entityType: 'hr_record', entityName: 'Self-Report' });
  await refreshActivePanel();
  location.hash = `#/personnel/${data.id}`;
  hrPfEditSelfReport(data.id);   // open straight into the editor
}
async function hrPfEditSelfReport(id) {
  const { data: r } = await sb.from('performance_reviews').select('*').eq('id', id).maybeSingle();
  if (!r || r.finalized || r.author_id !== _authUserId) { alert('This self-report can no longer be edited.'); return; }
  const def = Array.isArray(r.frozen_definition) ? r.frozen_definition : [];
  const ans = r.answers || {};
  const fields = def.map(f => fieldInput(f, ans[f.id])).join('');
  openModalHtml(`
    <div class="modal-title">Self-Report</div>
    <div style="font-size:12px;color:#6B7280;margin-bottom:.6rem;">Editable until a supervisor finalizes it.</div>
    ${fields}
    <label>Date</label><input type="date" id="hr-rev-date" value="${r.review_date || todayISO()}" />
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="window.hrPfSaveSelfReport('${id}')">Save</button>
    </div>`);
}
async function hrPfSaveSelfReport(id) {
  const { data: r } = await sb.from('performance_reviews').select('*').eq('id', id).maybeSingle();
  if (!r || r.finalized || r.author_id !== _authUserId) { alert('This self-report can no longer be edited.'); return; }
  const def = Array.isArray(r.frozen_definition) ? r.frozen_definition : [];
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
    } else { answers[f.id] = val(aid) || null; }
  }
  const { error } = await withWriteRetry(() => sb.from('performance_reviews').update({ answers, review_date: val('hr-rev-date') || null, updated_at: nowIso() }).eq('id', id), { kind: 'update' });
  if (error) { alert('Save failed: ' + error.message); return; }
  window.flashSavedThen(async () => { closeModal(); await refreshActivePanel(); });
}
async function hrPfFinalize(id) {
  if (!_file || _file.mode !== 'manage') return;
  if (!hrCanFinalizeSelfReport(viewerPersonId(), _file.personId, _file.institutionId, _ctx)) return;
  if (!confirm('Finalize this self-report? The employee can no longer edit it; it becomes read-only.')) return;
  const { error } = await withWriteRetry(() => sb.from('performance_reviews').update({ finalized: true, finalized_at: nowIso(), finalized_by: _authUserId, updated_at: nowIso() }).eq('id', id), { kind: 'update' });
  if (error) { alert('Finalize failed: ' + error.message); return; }
  logActivity({ action: 'finalized self report', entityType: 'hr_record', entityName: 'Self-Report' });
  await refreshActivePanel();
}
async function hrPfArchiveOwn(id) {
  const { data: r } = await sb.from('performance_reviews').select('*').eq('id', id).maybeSingle();
  if (!r || r.finalized || r.author_id !== _authUserId) { alert('This self-report can no longer be deleted.'); return; }
  if (!confirm('Delete this self-report? It moves to the archive.')) return;
  const { error } = await withWriteRetry(() => sb.from('performance_reviews').update({ archived_at: nowIso() }).eq('id', id), { kind: 'update' });
  if (error) { alert('Delete failed: ' + error.message); return; }
  await refreshActivePanel();
  location.hash = '#/personnel';
}

// ── Mark a person departed from this institution (super-admin) → file archives ──
async function hrPfMarkDeparted() {
  if (!_file || !isSuperAdmin()) return;
  const name = _ctx.personName(_file.personId);
  if (!confirm(`Mark ${name} as departed from this institution? Their positions here are vacated and their file moves to the archive (super-admin only).`)) return;
  const { error } = await withWriteRetry(() => sb.from('institution_departures')
    .upsert({ person_id: _file.personId, institution_id: _file.institutionId }, { onConflict: 'person_id,institution_id' }), { kind: 'create' });
  if (error) { alert('Failed: ' + error.message); return; }
  // Vacate their current occupancies in this institution (soft-end).
  const occIds = [];
  for (const [posId, occs] of _ctx.currentByPos) {
    if (_ctx.posById.get(posId)?.institution_id !== _file.institutionId) continue;
    occs.forEach(o => { if (o.person_id === _file.personId) occIds.push(o.id); });
  }
  if (occIds.length) await sb.from('person_positions').update({ unlinked_at: nowIso() }).in('id', occIds);
  logActivity({ action: 'archived departed personnel file', entityType: 'hr_record', entityName: name });
  _file = null;
  if ((location.hash || '').startsWith('#/personnel')) location.hash = '';
  await loadHr();
}

// ── Super-admin Archive: deleted records + departed-employee files, by name ────
async function openHrArchive() {
  if (!isSuperAdmin()) return;
  openModalHtml(`<div class="modal-title">HR Archive</div><div style="font-size:12.5px;color:#9CA3AF;">Loading…</div>`);
  const TABLES = [['review', 'performance_reviews'], ['disciplinary', 'disciplinary_records'], ['incident', 'incident_reports'], ['memo', 'memos']];
  const out = [];
  // (a) Individually deleted records.
  for (const [type, table] of TABLES) {
    const { data } = await sb.from(table).select('*').not('archived_at', 'is', null);
    (data || []).forEach(r => out.push({ ...r, _type: type, _reason: 'deleted' }));
  }
  // (b) Whole files of departed (person, institution) pairs (their live records).
  const { data: deps } = await sb.from('institution_departures').select('*');
  for (const d of (deps || [])) {
    for (const [type, table] of TABLES) {
      const { data } = await sb.from(table).select('*').eq('person_id', d.person_id).eq('institution_id', d.institution_id).is('archived_at', null);
      (data || []).forEach(r => out.push({ ...r, _type: type, _reason: 'departed' }));
    }
  }
  const byPerson = new Map();
  out.forEach(r => { const n = _ctx?.personName(r.person_id) || 'Unknown'; (byPerson.get(n) || byPerson.set(n, []).get(n)).push(r); });
  const groups = [...byPerson.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  _archiveCache = out;
  const body = groups.length
    ? groups.map(([name, recs]) => `
        <div style="margin-bottom:.85rem;">
          <div style="font-weight:600;color:var(--navy);font-size:13.5px;margin-bottom:.35rem;">${esc(name)}</div>
          ${recs.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(r => `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:.4rem .55rem;background:#F8F7F4;border:.5px solid var(--stone);border-radius:6px;margin-bottom:.3rem;">
              <span style="font-size:12.5px;color:var(--navy);">${esc(RECORD_CHIP[chipKey(r)].label)} · ${esc(createdMDY(r.created_at))} <span style="color:#9CA3AF;">(${r._reason})</span></span>
              <span style="display:flex;gap:8px;flex-shrink:0;">
                <button class="card-action" onclick="window.hrArchiveView('${r._type}','${r.id}')">View</button>
                <button class="card-action" style="color:#A32D2D;" onclick="window.hrArchiveDelete('${r._type}','${r.id}')">Delete permanently</button>
              </span>
            </div>`).join('')}
        </div>`).join('')
    : `<div style="font-size:13px;color:#6B7280;font-style:italic;">The archive is empty.</div>`;
  openModalHtml(`
    <div class="modal-title">HR Archive</div>
    <div style="font-size:11.5px;color:#9CA3AF;margin-bottom:.7rem;">Deleted files and departed-employee files, filed by name. Super-admin only.</div>
    ${body}
    <div class="modal-actions"><button class="btn-secondary" onclick="closeModal()">Close</button></div>`);
}
function hrArchiveView(type, id) {
  const r = (_archiveCache || []).find(x => x._type === type && x.id === id);
  if (!r) return;
  // _file is null here → recordControlsHtml renders nothing (read-only).
  openModalHtml(`
    <div class="modal-title">${esc(RECORD_CHIP[chipKey(r)].label)} — archived</div>
    ${recordDetailHtml(r)}
    <div class="modal-actions"><button class="btn-secondary" onclick="window.hrReopenArchive()">Back</button></div>`);
}
function hrReopenArchive() { openHrArchive(); }
async function hrArchiveDelete(type, id) {
  if (!isSuperAdmin()) return;
  if (!confirm('Permanently delete this record from the archive? This cannot be undone.')) return;
  const ends = await getLinks(type, id);
  await Promise.all(ends.map(e => unlinkRecords(type, id, e.type, e.id)));
  const { error } = await deleteWithRetry(() => sb.from(RECORD_META[type].table).delete().eq('id', id));
  if (error) { alert('Delete failed: ' + error.message); return; }
  logActivity({ action: 'permanently deleted archived record', entityType: 'hr_record', entityName: RECORD_META[type].label });
  openHrArchive();
}

// ── Expose modal-button + record handlers (tree actions use delegation) ─────

Object.assign(window, {
  hrSaveInstitution, hrSavePosition, hrSaveMove, hrSaveLink, hrExportPdf,
  // template builder
  hrNewTemplate, hrStartFromStarter, hrEditTemplate, hrDeleteTemplate,
  hrCloseBuilder, hrTbAdd, hrTbMove, hrTbDel, hrSaveTemplate,
  // personnel record panel (Phase 2)
  hrPfNew, hrPfNewReviewTemplate, hrPfNewReviewStarter,
  hrPfOpenLinkPicker, hrPfDoLink, hrPfUnlink,
  // Phase 3 — self-report, finalize, archive
  hrPfEditSelfReport, hrPfSaveSelfReport, hrPfFinalize, hrPfArchiveOwn,
  hrArchiveView, hrReopenArchive, hrArchiveDelete,
});
