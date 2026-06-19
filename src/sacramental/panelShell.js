// ── Sacramental master-detail shell (config-driven) ─────────────────────────
// One reusable split-pane shell that every sacramental panel plugs into via a
// config object. The shell owns layout, list/detail panes, search, status
// filter pills, optional collapsible grouping, read-first detail, inline edit,
// hash-based deep-linking, responsive behavior, and bulk-select. Everything
// panel-specific (queries, fields, status logic, edit form, save) comes from the
// config — see baptismConfig.js and the schema in ARCHITECTURE.md.

import { todayCST } from '../utils.js';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ── Shared sort behaviors (sortByDate + archived-last) ──────────────────────
// Archive is the EXISTING per-record `archived` boolean (couples / sacramental_*);
// the shell never invents a new flag. Archived records always sort below active.
const isArchived = (r) => !!(r && r.archived);
// Active date order: records with NO date at the TOP (active work needing
// scheduling), then UPCOMING soonest-first, then past most-recent-first.
function dateActiveCompare(a, b, field) {
  const da = a[field] || '', db = b[field] || '', today = todayCST();
  const rank = (d) => !d ? 0 : (d >= today ? 1 : 2);   // 0 no-date, 1 upcoming, 2 past
  const ra = rank(da), rb = rank(db);
  if (ra !== rb) return ra - rb;
  if (ra === 1) return da.localeCompare(db);            // upcoming: soonest first
  if (ra === 2) return db.localeCompare(da);            // past: most recent first
  return 0;                                             // both no-date → caller tiebreak
}
// Clickable Archived divider for the flat panels (Baptism/Marriage). Toggles the
// shared '__archived' collapse key, mirroring the grouped panels' Archived group.
function archivedDivider(collapsed) {
  return `<div data-act="toggle-group" data-key="__archived" style="display:flex;align-items:center;gap:8px;margin:14px 0 6px;font-size:11px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:#9CA3AF;cursor:pointer;">
    <div style="flex:1;height:1px;background:var(--stone);"></div>
    <i class="fa-solid fa-chevron-${collapsed ? 'right' : 'down'}" style="font-size:9px;"></i>Archived
    <div style="flex:1;height:1px;background:var(--stone);"></div></div>`;
}

// Map a chip/flag tone to an existing badge token class (dark-mode handled in CSS).
const TONE_CLASS = { pending: 'badge-pending', active: 'badge-active', urgent: 'badge-urgent', complete: 'badge-complete', neutral: 'badge-complete' };
function chipHtml(c) {
  // A chip may supply an explicit `style` to override the tone palette (e.g.
  // Marriage's per-status colors). Dark mode's !important badge rule still wins.
  const st = c.style ? ` style="${c.style}"` : '';
  return `<span class="badge ${TONE_CLASS[c.tone] || 'badge-complete'}"${st}>${esc(c.label)}</span>`;
}
const FLAG_COLOR = { urgent: 'var(--cardinal)', warn: '#9A6A1E', info: '#1B4F72' };
function flagHtml(f) {
  return `<span class="sac-flag" title="${esc(f.label)}" style="color:${FLAG_COLOR[f.tone] || 'var(--cardinal)'};"><i class="fa-solid ${f.icon || 'fa-flag'}"></i>${f.short ? esc(f.short) : ''}</span>`;
}

// ── Single active instance (only one sacramental panel is visible at a time) ─
let _active = null;   // { config, container, records, selectedId, editing, filter, search, bulk, selected:Set }

export function renderSacramentalPanel(containerEl, config) {
  _active = {
    config, container: containerEl,
    records: [], selectedId: null, editing: false,
    filter: 'all', search: '',
    bulk: false, selected: new Set(),
    groupsCollapsed: new Set(), groupInit: false,
  };
  containerEl.innerHTML = `<div class="sac-shell" id="sac-shell"></div>`;
  containerEl.querySelector('#sac-shell').addEventListener('click', onShellClick);
  refresh(/*initial*/true);
}

// Public deep-link hook (the future #mention case-linking will call this).
export function openSacramentalRecord(panelKey, recordId) {
  location.hash = `#/${panelKey}/${recordId}`;
}

// ── Data + routing ──────────────────────────────────────────────────────────
async function refresh(initial) {
  const s = _active; if (!s) return;
  s.records = (await s.config.fetchRecords()) || [];
  applyHash();           // pick up #/panel/:id selection
  render();
  if (initial) window.addEventListener('hashchange', onHashChange);
}

function onHashChange() {
  if (!_active) return;
  applyHash();
  render();
}
function applyHash() {
  const s = _active;
  const m = (location.hash || '').match(new RegExp(`^#/${s.config.panelKey}(?:/([^/]+))?$`));
  if (!m) return;                       // hash is for a different panel — leave as-is
  s.selectedId = m[1] || null;
  if (!s.selectedId) s.editing = false;
}
function selectRecord(id) {
  // Routing is the source of truth — set the hash, let onHashChange render.
  if (id) location.hash = `#/${_active.config.panelKey}/${id}`;
  else location.hash = `#/${_active.config.panelKey}`;
}

// ── Render ──────────────────────────────────────────────────────────────────
function render() {
  const s = _active; if (!s) return;
  const shell = s.container.querySelector('#sac-shell');
  if (!shell) return;
  shell.classList.toggle('detail-open', !!s.selectedId);
  shell.innerHTML = `<div class="sac-list">${listPaneHtml()}</div><div class="sac-detail">${detailPaneHtml()}</div>`;
}

function visibleRecords() {
  const s = _active, cfg = s.config;
  const q = s.search.trim().toLowerCase();
  const f = (cfg.statusFilters || []).find(x => x.key === s.filter);
  const out = s.records.filter(r => {
    if (f && f.match && !f.match(r)) return false;
    if (q) {
      const txt = (cfg.searchText ? cfg.searchText(r) : cfg.listItem(r).title) || '';
      if (!String(txt).toLowerCase().includes(q)) return false;
    }
    return true;
  });
  if (cfg.compare) out.sort(cfg.compare);   // alphabetical (within groups too, since groups read this order)
  return out;
}

function listPaneHtml() {
  const s = _active, cfg = s.config;
  const canManage = cfg.canManage ? cfg.canManage() : true;
  const pills = (cfg.statusFilters || []).map(f =>
    `<button class="cf-btn${s.filter === f.key ? ' active' : ''}" data-act="filter" data-key="${f.key}">${esc(f.label)}</button>`).join('');
  const listBody = listBodyHtml();

  const bulkBar = s.bulk
    ? `<div class="sac-bulkbar">
         <span>${s.selected.size} selected</span>
         ${(cfg.bulkStatusOptions || []).length ? `<select id="sac-bulk-status" style="font-size:12px;padding:2px 6px;border-radius:4px;">${(cfg.bulkStatusOptions || []).map(o => `<option value="${o.key}">${esc(o.label)}</option>`).join('')}</select>
         <button class="btn-secondary" style="padding:.25rem .7rem;font-size:12px;" data-act="bulk-apply">Change status</button>` : ''}
       </div>` : '';

  return `
    <div class="sac-list-head">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:.55rem;">
        <span class="sac-list-title">${esc(cfg.title)}</span>
        ${canManage ? `<button class="btn-primary" style="padding:.3rem .7rem;font-size:12px;white-space:nowrap;" data-act="new">${esc(cfg.newLabel || '+ New')}</button>` : ''}
      </div>
      <input type="text" id="sac-search" placeholder="Search…" value="${esc(s.search)}" data-act="search"
        style="width:100%;box-sizing:border-box;border-radius:var(--radius-sm);border:.5px solid var(--stone);padding:.4rem .6rem;font-size:13px;font-family:'Inter',sans-serif;outline:none;" />
      <div style="display:flex;gap:5px;margin-top:.5rem;flex-wrap:wrap;align-items:center;">
        ${pills}
        ${canManage ? `<button class="cf-btn" data-act="bulk-toggle" title="Select multiple" style="margin-left:auto;${s.bulk ? 'background:var(--navy);color:var(--gold);' : ''}"><i class="fa-solid fa-list-check"></i></button>` : ''}
        ${cfg.openManageCohorts && cfg.canManageTemplate && cfg.canManageTemplate() ? `<button class="cf-btn" data-act="cohorts" title="Manage cohorts"><i class="fa-solid fa-children"></i></button>` : ''}
        ${cfg.canManageTemplate && cfg.canManageTemplate() ? `<button class="cf-btn" data-act="template" title="Settings"><i class="fa-solid fa-gear"></i></button>` : ''}
      </div>
    </div>
    ${bulkBar}
    <div class="sac-list-scroll">${listBody}</div>`;
}

// Builds the list body — flat (Baptism) or collapsible cohort groups (First
// Communion). Used by listPaneHtml AND the live-search re-render so grouping is
// consistent in both. Additive: the flat path is byte-for-byte the old output.
function listBodyHtml() {
  const s = _active, cfg = s.config;
  const recs = visibleRecords();
  if (!recs.length) return `<div style="font-size:13px;color:#6B7280;padding:.5rem;">No records match.</div>`;

  // Flat path (Baptism, Marriage). With no date sort and no archived records the
  // output is byte-for-byte the old flat list. Otherwise: active records (sorted
  // by sortByDate when set) above, then an "Archived" cluster (most recent first).
  if (!cfg.groupBy) {
    const hasArchived = recs.some(isArchived);
    if (!cfg.sortByDate && !hasArchived) return recs.map(itemHtml).join('');
    const active = recs.filter(r => !isArchived(r));
    const archived = recs.filter(isArchived);
    if (cfg.sortByDate) {
      active.sort((a, b) => dateActiveCompare(a, b, cfg.sortByDate) || (cfg.compare ? cfg.compare(a, b) : 0));
      archived.sort((a, b) => ((b[cfg.sortByDate] || '').localeCompare(a[cfg.sortByDate] || '')) || (cfg.compare ? cfg.compare(a, b) : 0));
    }
    let html = active.map(itemHtml).join('');
    if (archived.length) {
      // Default: Archived collapsed (set once per mount); user can toggle. Active
      // search force-expands so matches in archived records aren't hidden.
      if (!s.groupInit) { s.groupsCollapsed.add('__archived'); s.groupInit = true; }
      const collapsed = !s.search.trim() && s.groupsCollapsed.has('__archived');
      html += archivedDivider(collapsed) + (collapsed ? '' : archived.map(itemHtml).join(''));
    }
    return html;
  }

  // Group, then order keys: the "__archived" group always sinks to the very bottom,
  // then "__none" (Unassigned); otherwise by the config's groupCompare (most-recent
  // first) so the newest cohort leads. (Additive: only affects panels whose groupBy
  // emits "__archived" — Confirmation / First Communion never do, so unchanged.)
  const groups = new Map();
  recs.forEach(r => { const k = cfg.groupBy(r) ?? '__none'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === '__archived') return 1; if (b === '__archived') return -1;
    if (a === '__none') return 1; if (b === '__none') return -1;
    return cfg.groupCompare ? cfg.groupCompare(a, b) : 0;
  });

  // Initial collapse (once per mount, UI-only): ALL groups open EXCEPT the Archived
  // group ('__archived'). The user's manual toggles thereafter are respected.
  if (!s.groupInit) { s.groupsCollapsed = new Set(keys.filter(k => k === '__archived')); s.groupInit = true; }

  const searching = !!s.search.trim();   // active search force-expands all groups
  const label = (k) => k === '__none' ? (cfg.noneLabel || 'Unassigned') : (cfg.groupLabel ? cfg.groupLabel(k) : k);
  // Archived-last within a list (stable — non-archived keep their order).
  const archivedLast = (arr) => [...arr.filter(r => !isArchived(r)), ...arr.filter(isArchived)];
  return keys.map(k => {
    const rows = groups.get(k);
    const collapsed = !searching && s.groupsCollapsed.has(k);
    let body = '';
    if (!collapsed) {
      if (cfg.subGroupBy) {
        // Optional second-level sub-grouping (e.g. Confirmation youth/adult). Sub
        // headers are a lighter, secondary treatment; archived-last per sub-section.
        const subs = new Map();
        rows.forEach(r => { const sk = cfg.subGroupBy(r) ?? '__sub'; if (!subs.has(sk)) subs.set(sk, []); subs.get(sk).push(r); });
        const order = cfg.subGroupOrder || [...subs.keys()];
        const subKeys = [...subs.keys()].sort((a, b) => {
          const ia = order.indexOf(a), ib = order.indexOf(b);
          return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
        });
        body = subKeys.map(sk => {
          const sub = archivedLast(subs.get(sk));
          const sl = cfg.subGroupLabel ? cfg.subGroupLabel(sk, k) : sk;
          return `<div style="font-size:10.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#9CA3AF;margin:8px 0 3px;padding-left:2px;">${esc(sl)} <span style="font-weight:400;">(${sub.length})</span></div>`
            + sub.map(itemHtml).join('');
        }).join('');
      } else {
        body = archivedLast(rows).map(itemHtml).join('');
      }
    }
    return `<div class="sac-group">
      <div class="sac-group-head" data-act="toggle-group" data-key="${esc(k)}">
        <i class="fa-solid fa-chevron-${collapsed ? 'right' : 'down'}" style="font-size:10px;"></i>
        ${esc(label(k))} <span style="color:#9CA3AF;font-weight:400;">(${rows.length})</span>
      </div>
      ${body}
    </div>`;
  }).join('');
}

function itemHtml(r) {
  const s = _active, cfg = s.config;
  const it = cfg.listItem(r);
  const sel = s.selectedId === r.id;
  const checked = s.selected.has(r.id);
  const cb = s.bulk ? `<input type="checkbox" ${checked ? 'checked' : ''} data-act="check" data-id="${r.id}" style="width:15px;height:15px;accent-color:var(--cardinal);margin-top:2px;" />` : '';
  return `<div class="sac-item${sel ? ' selected' : ''}" data-act="open" data-id="${r.id}">
    <div class="sac-item-row">
      ${cb}
      <div style="flex:1;min-width:0;">
        <div class="sac-item-title">${esc(it.title)}</div>
        ${it.secondary ? `<div class="sac-item-sub">${esc(it.secondary)}</div>` : ''}
        <div style="display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-top:5px;">
          ${(it.chips || []).map(chipHtml).join('')}
          ${(it.flags || []).map(flagHtml).join('')}
        </div>
      </div>
    </div>
  </div>`;
}

function detailPaneHtml() {
  const s = _active, cfg = s.config;
  if (!s.selectedId) {
    return `<div class="sac-empty"><i class="fa-solid fa-folder-open" style="font-size:30px;opacity:.4;"></i><div style="font-size:14px;">Select a file to open it</div></div>`;
  }
  const r = cfg.fetchRecord(s.selectedId);
  if (!r) return `<div class="sac-empty"><div>File not found.</div></div>`;

  if (s.editing) {
    return `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:.5rem;">
        <button class="sac-back" data-act="cancel-edit">‹</button>
        <span class="sac-section-title" style="border:none;margin:0;padding:0;">Editing</span>
      </div>
      <div id="sac-editform">${cfg.editForm(r)}</div>
      <div class="modal-actions" style="justify-content:space-between;margin-top:1.25rem;">
        ${cfg.deleteRecord ? `<button class="btn-delete" data-act="delete" data-id="${r.id}">Delete</button>` : '<span></span>'}
        <div style="display:flex;gap:8px;">
          <button class="btn-secondary" data-act="cancel-edit">Cancel</button>
          <button class="btn-primary" id="sac-save" data-act="save" data-id="${r.id}">Save</button>
        </div>
      </div>`;
  }

  const head = cfg.detailHeader(r);
  const canManage = cfg.canManage ? cfg.canManage() : true;
  // Action buttons: icon + a labelled span. The CSS class carries padding/font (so the
  // mobile media query can restyle them to icon-only ~44px tap targets); the aria-label
  // keeps an accessible name when the label span is hidden on mobile.
  const actions = (cfg.actions || []).map((a, i) =>
    `<button class="btn-secondary sac-detail-btn" data-act="action" data-i="${i}" data-id="${r.id}" aria-label="${esc(a.label)}">${a.icon ? `<i class="fa-solid ${a.icon}"></i> ` : ''}<span class="sac-btn-label">${esc(a.label)}</span></button>`).join('');
  const sections = (cfg.detailSections || []).filter(sec => !sec.when || sec.when(r)).map(sec =>
    `<div class="sac-section"><div class="sac-section-title">${esc(sec.title)}</div><div>${sec.render(r)}</div></div>`).join('');

  return `
    <div class="sac-detail-head">
      <button class="sac-back" data-act="back" aria-label="Back">‹</button>
      <div class="sac-avatar">${head.avatarIcon ? `<i class="fa-solid ${esc(head.avatarIcon)}"></i>` : esc(head.initials || '?')}</div>
      <div class="sac-detail-main">
        <div class="sac-detail-name">${esc(head.name)}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;">
          ${(head.chips || []).map(chipHtml).join('')}
          ${(head.flags || []).map(flagHtml).join('')}
        </div>
      </div>
      <div class="sac-detail-actions">
        ${actions}
        ${canManage ? `<button class="btn-primary sac-detail-btn" data-act="edit" data-id="${r.id}" aria-label="Edit"><i class="fa-solid fa-pencil"></i> <span class="sac-btn-label">Edit</span></button>` : ''}
      </div>
    </div>
    ${sections}`;
}

// ── Event delegation ────────────────────────────────────────────────────────
async function onShellClick(e) {
  const s = _active; if (!s) return;
  const t = e.target.closest('[data-act]');
  if (!t) return;
  const act = t.dataset.act, cfg = s.config;

  switch (act) {
    case 'filter':     s.filter = t.dataset.key; render(); break;
    case 'search':     break;  // handled by input listener below
    case 'toggle-group': { const k = t.dataset.key; s.groupsCollapsed.has(k) ? s.groupsCollapsed.delete(k) : s.groupsCollapsed.add(k); render(); break; }
    case 'new':        cfg.openCreate?.(); break;
    case 'template':   cfg.openTemplate?.(); break;
    case 'cohorts':    cfg.openManageCohorts?.(); break;
    case 'bulk-toggle': s.bulk = !s.bulk; if (!s.bulk) s.selected.clear(); render(); break;
    case 'check': {     // checkbox click inside a card — toggle selection, don't open
      e.stopPropagation();
      const id = t.dataset.id;
      s.selected.has(id) ? s.selected.delete(id) : s.selected.add(id);
      render(); break;
    }
    case 'open': {
      const id = t.dataset.id;
      if (s.bulk) { s.selected.has(id) ? s.selected.delete(id) : s.selected.add(id); render(); }
      else selectRecord(id);
      break;
    }
    case 'bulk-apply': {
      if (!s.selected.size || !cfg.bulkUpdateStatus) return;
      const status = s.container.querySelector('#sac-bulk-status')?.value;
      await cfg.bulkUpdateStatus([...s.selected], status);
      s.records = (await cfg.fetchRecords()) || [];
      s.selected.clear(); s.bulk = false; render();
      break;
    }
    case 'back': selectRecord(null); break;
    case 'edit': s.editing = true; render(); cfg.onEditMount?.(cfg.fetchRecord(s.selectedId)); break;
    case 'cancel-edit': s.editing = false; render(); break;
    case 'action': { const a = (cfg.actions || [])[+t.dataset.i]; a?.handler?.(cfg.fetchRecord(t.dataset.id)); break; }
    case 'save': {
      const id = t.dataset.id;
      const res = await cfg.saveRecord(id);
      if (res && res.ok) {
        s.records = (await cfg.fetchRecords()) || [];   // pick up updated chips/flags
        s.editing = false; render();
      }
      break;
    }
    case 'delete': {
      const id = t.dataset.id;
      const res = cfg.deleteRecord ? await cfg.deleteRecord(id) : null;
      if (res && res.ok) { s.records = (await cfg.fetchRecords()) || []; selectRecord(null); s.editing = false; render(); }
      break;
    }
  }
}

// Search input (delegated 'input' on the container, debounced).
let _searchT = null;
document.addEventListener('input', (e) => {
  if (!_active) return;
  if (e.target && e.target.id === 'sac-search') {
    const v = e.target.value;
    clearTimeout(_searchT);
    _searchT = setTimeout(() => {
      _active.search = v;
      // re-render only the list scroll to keep focus in the search box
      // (group-aware: search filters across groups and auto-expands matches).
      const scroll = _active.container.querySelector('.sac-list-scroll');
      if (scroll) scroll.innerHTML = listBodyHtml();
    }, 150);
  }
});

// Allow a config's inline edit form to ask the shell to re-render the read view
// after an external save (e.g. the create modal reloading data).
export async function refreshActivePanel() {
  if (!_active) return;
  _active.records = (await _active.config.fetchRecords()) || [];
  render();
}
