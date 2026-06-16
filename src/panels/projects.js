import { sb } from '../supabase.js';
import { store } from '../store.js';
import { fmtDate, logActivity } from '../utils.js';
import { notifyUsers, getUserIdsForTeam, getUserIdForPersonnel } from '../notifications.js';
import { updateProjectStats, renderDashProjects } from './dashboard.js';
import { createContactPicker } from '../ui/contactPicker.js';
import { getUserScope, isVisible, scopeNotice } from '../ui/userScope.js';
import { isAdmin } from '../roles.js';

// ── Status config ──────────────────────────────────────────────────────────

export const STATUS = {
  in_progress:  { label: 'In Progress',  color: '#7A5C00', bg: '#FDF3D0', dot: '#C9A84C' },
  blocked:      { label: 'Blocked',      color: '#7A1020', bg: '#FDEAED', dot: '#8B1A2F' },
  not_started:  { label: 'Not Started',  color: '#4B5563', bg: '#F3F4F6', dot: '#9CA3AF' },
  complete:     { label: 'Complete',     color: '#F5F1EB', bg: '#1C2B3A', dot: '#1C2B3A' },
};

export const GROUP_ORDER = ['in_progress', 'blocked', 'not_started', 'complete'];

// ── Module state ───────────────────────────────────────────────────────────

let _newProjPicker    = null;
let _newProjAssignees = [];
let _newProjTeamId    = null;
let _searchQuery      = '';
let _statusFilter     = 'all';
let _teamFilter       = null; // null = all teams

// ── Data ───────────────────────────────────────────────────────────────────

export async function invalidateProjects() {
  store.allProjects = [];
  store._projectScopeReady = undefined;
}

export async function loadProjects() {
  // Use cached store data if scope is already resolved (e.g. populated by loadInit)
  if (store.allProjects?.length > 0 && store._projectScopeReady !== undefined) {
    renderProjects();
    return;
  }

  const scope = await getUserScope();

  const { data, error } = await sb
    .from('projects')
    .select('*')
    .order('due_date', { nullsFirst: false })
    .order('created_at');
  if (error) { console.error('[projects]', error); return; }

  store.allProjects = (data || []).filter(p => isVisible(p, scope));
  store._projectScopeReady = scope.ready;
  renderProjects();
  updateProjectStats();
  renderDashProjects();
}

// ── Landing render ─────────────────────────────────────────────────────────

export function renderProjects() {
  _renderTeamBar();
  _initFilterBar();

  const el = document.getElementById('projects-list');
  if (!el) return;

  const notice = store._projectScopeReady === false ? scopeNotice() : '';
  let items = store.allProjects || [];

  // Apply team filter
  if (_teamFilter) {
    items = items.filter(p => p.team_id === _teamFilter);
  }

  // Apply search
  if (_searchQuery) {
    const q = _searchQuery.toLowerCase();
    items = items.filter(p =>
      p.title?.toLowerCase().includes(q) ||
      p.notes?.toLowerCase().includes(q)
    );
  }

  // Apply status filter
  if (_statusFilter !== 'all') {
    items = items.filter(p => (p.status_code || 'not_started') === _statusFilter);
  }

  if (!items.length) {
    const msg = (_searchQuery || _statusFilter !== 'all' || _teamFilter)
      ? 'No projects match your filters.'
      : 'No projects yet. Use the button above to create one.';
    el.innerHTML = notice + `<div style="font-size:13px;color:#6B7280;padding:.5rem 0;">${msg}</div>`;
    return;
  }

  const grouped = {};
  items.forEach(p => {
    const key = p.status_code || 'not_started';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(p);
  });

  let html = '';
  GROUP_ORDER.forEach(s => {
    const group = grouped[s];
    if (!group?.length) return;
    const st = STATUS[s];
    html += `
      <div style="margin-bottom:1.5rem;">
        <div style="font-size:11px;font-weight:700;letter-spacing:.07em;color:#9CA3AF;text-transform:uppercase;margin-bottom:.6rem;display:flex;align-items:center;gap:6px;">
          <span style="width:7px;height:7px;border-radius:50%;background:${st.dot};flex-shrink:0;display:inline-block;"></span>
          ${st.label} <span style="font-weight:400;color:#C4BDB3;">(${group.length})</span>
        </div>
        ${group.map(p => projectCard(p)).join('')}
      </div>`;
  });
  el.innerHTML = notice + html;
}

// ── Filter bar ─────────────────────────────────────────────────────────────

const _FILTER_OPTIONS = [
  { key: 'all',         label: 'All' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'blocked',     label: 'Blocked' },
  { key: 'not_started', label: 'Not Started' },
  { key: 'complete',    label: 'Complete' },
];

function _filterPillHtml(key, label) {
  const active = key === _statusFilter;
  return `<button class="proj-filter-btn" data-filter="${key}" style="
    padding:.28rem .75rem;font-size:12px;font-family:'Inter',sans-serif;font-weight:500;
    border-radius:20px;border:.5px solid ${active ? '#C9A84C' : '#D1C9BE'};
    background:${active ? '#C9A84C' : '#fff'};color:${active ? '#fff' : '#1C2B3A'};
    cursor:pointer;white-space:nowrap;
  ">${label}</button>`;
}

function _updateFilterPills() {
  const bar = document.getElementById('proj-filter-bar');
  if (!bar) return;
  bar.querySelectorAll('.proj-filter-btn').forEach(btn => {
    const active = btn.dataset.filter === _statusFilter;
    btn.style.background   = active ? '#C9A84C' : '#fff';
    btn.style.color        = active ? '#fff'    : '#1C2B3A';
    btn.style.borderColor  = active ? '#C9A84C' : '#D1C9BE';
  });
}

function _initFilterBar() {
  const bar = document.getElementById('proj-filter-bar');
  if (!bar || bar.dataset.inited) return;
  bar.dataset.inited = '1';

  bar.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:1rem;">
      <div style="position:relative;flex:0 0 auto;width:clamp(180px,300px,100%);">
        <i class="fa-solid fa-magnifying-glass" style="
          position:absolute;left:9px;top:50%;transform:translateY(-50%);
          color:#9CA3AF;font-size:11px;pointer-events:none;
        "></i>
        <input id="proj-search" placeholder="Search projects…" autocomplete="off" style="
          width:100%;box-sizing:border-box;padding:.38rem .75rem .38rem 2rem;
          border:.5px solid #D1C9BE;border-radius:6px;font-size:13px;
          font-family:'Inter',sans-serif;outline:none;background:#fff;
        " />
        <button id="proj-search-clear" style="
          display:none;position:absolute;right:8px;top:50%;transform:translateY(-50%);
          background:none;border:none;cursor:pointer;color:#9CA3AF;
          font-size:13px;padding:0;line-height:1;
        ">✕</button>
      </div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;">
        ${_FILTER_OPTIONS.map(f => _filterPillHtml(f.key, f.label)).join('')}
      </div>
    </div>
  `;

  const searchInput = bar.querySelector('#proj-search');
  const clearBtn    = bar.querySelector('#proj-search-clear');

  searchInput.addEventListener('input', () => {
    _searchQuery = searchInput.value;
    clearBtn.style.display = _searchQuery ? '' : 'none';
    renderProjects();
  });

  clearBtn.addEventListener('click', () => {
    _searchQuery = '';
    searchInput.value = '';
    clearBtn.style.display = 'none';
    renderProjects();
  });

  bar.querySelectorAll('.proj-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _statusFilter = btn.dataset.filter;
      _updateFilterPills();
      renderProjects();
    });
  });
}

function _pill(label, active, onClick) {
  return `<button style="
    padding:.26rem .72rem;font-size:12px;font-family:'Inter',sans-serif;font-weight:500;
    border-radius:20px;border:.5px solid ${active ? '#1C2B3A' : '#D1C9BE'};
    background:${active ? '#1C2B3A' : '#fff'};color:${active ? '#fff' : '#6B7280'};
    cursor:pointer;white-space:nowrap;" onclick="${onClick}">${label}</button>`;
}

function _renderTeamBar() {
  const bar = document.getElementById('proj-team-bar');
  if (!bar) return;

  // Teams that have at least one project in store
  const allProjs = store.allProjects || [];
  const teamIds  = [...new Set(allProjs.map(p => p.team_id).filter(Boolean))];
  const teams    = (store.teams || []).filter(t => teamIds.includes(t.id));

  if (!teams.length) { bar.innerHTML = ''; return; }

  const pills = [
    _pill('All Teams', !_teamFilter, "window._projTeamFilter(null)"),
    ...teams.map(t => _pill(t.name, _teamFilter === t.id, `window._projTeamFilter('${t.id}')`)),
  ].join('');

  bar.innerHTML = `<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:.75rem;">${pills}</div>`;
}

window._projTeamFilter = (teamId) => { _teamFilter = teamId; renderProjects(); };

function assigneeLabel(ids) {
  if (!ids?.length) return null;
  const people = store.personnel || [];
  const names = ids.map(id => people.find(p => p.id === id)?.name).filter(Boolean);
  if (!names.length) return null;
  const shown = names.slice(0, 2).join(', ');
  return names.length > 2 ? `${shown} +${names.length - 2} more` : shown;
}

function statusBadge(code) {
  const st = STATUS[code] || STATUS.not_started;
  return `<span style="font-size:10.5px;font-weight:700;background:${st.bg};color:${st.color};border-radius:20px;padding:2px 9px;white-space:nowrap;letter-spacing:.02em;">${st.label}</span>`;
}

export function projectCard(p) {
  const assignees = assigneeLabel(p.assigned_to);
  return `
    <div onclick="window.showProjectDashboard('${p.id}')" style="
      background:#FFFFFF;border:.5px solid #E2DDD6;border-radius:8px;
      padding:.9rem 1.05rem;margin-bottom:.55rem;cursor:pointer;
      transition:box-shadow .15s,border-color .15s;
    "
    onmouseover="this.style.boxShadow='0 4px 16px rgba(28,43,58,.12)';this.style.borderColor='#C9A84C';"
    onmouseout="this.style.boxShadow='';this.style.borderColor='#E2DDD6';">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:14.5px;font-weight:600;color:#1C2B3A;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${p.title}</div>
          ${p.notes ? `<div style="font-size:12px;color:#6B7280;margin-bottom:5px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${p.notes}</div>` : ''}
          <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
            ${statusBadge(p.status_code)}
            ${assignees ? `<span style="font-size:11.5px;color:#6B7280;">👤 ${assignees}</span>` : ''}
            ${p.due_date ? `<span style="font-size:11.5px;color:#6B7280;">📅 ${fmtDate(p.due_date)}</span>` : ''}
          </div>
        </div>
        <span style="color:#C9A84C;font-size:18px;margin-top:1px;flex-shrink:0;">›</span>
      </div>
    </div>`;
}

// ── New project modal ──────────────────────────────────────────────────────

export function openNewProjectModal({ teamId = null } = {}) {
  if (!isAdmin()) return;  // basic users cannot create projects
  _newProjAssignees = [];
  _newProjTeamId = teamId;
  document.getElementById('modal-content').innerHTML = `
    <div class="modal-title">New project</div>
    <label>Title</label>
    <input id="pf-title" placeholder="Project name" />
    <label>Status</label>
    <select id="pf-status">
      ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
    </select>
    <label>Members (optional)</label>
    <div id="pf-chips" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;min-height:0;"></div>
    <div id="pf-assignee-cp"></div>
    <label>Due date</label>
    <input type="date" id="pf-due" />
    <label>Notes</label>
    <textarea id="pf-notes" rows="3" placeholder="Optional description or notes"></textarea>
    <div class="modal-actions">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveNewProject()">Save</button>
    </div>
  `;
  document.getElementById('modal-overlay').classList.add('open');
  _initNewProjPicker();
}

function _initNewProjPicker() {
  _newProjPicker = createContactPicker({
    container: document.getElementById('pf-assignee-cp'),
    placeholder: 'Add a member…',
    onSelect: (person) => {
      if (!person) return;
      if (_newProjAssignees.find(p => p.id === person.id)) {
        _newProjPicker.clear();
        return;
      }
      _newProjAssignees.push(person);
      _renderNewProjChips();
      _newProjPicker.clear();
    },
  });
}

function _renderNewProjChips() {
  const el = document.getElementById('pf-chips');
  if (!el) return;
  el.innerHTML = _newProjAssignees.map(p => `
    <span style="
      display:inline-flex;align-items:center;gap:5px;
      background:#1C2B3A;color:#fff;border-radius:20px;
      padding:.25rem .65rem .25rem .75rem;font-size:12.5px;font-family:'Inter',sans-serif;
    ">
      ${p.name || '—'}
      <button data-remove-id="${p.id}" type="button" style="
        background:none;border:none;color:rgba(255,255,255,.65);
        cursor:pointer;font-size:13px;padding:0;line-height:1;
      " onmouseover="this.style.color='#fff'" onmouseout="this.style.color='rgba(255,255,255,.65)'">✕</button>
    </span>
  `).join('');
  el.querySelectorAll('[data-remove-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      _newProjAssignees = _newProjAssignees.filter(p => p.id !== btn.dataset.removeId);
      _renderNewProjChips();
    });
  });
}

async function saveNewProject() {
  const { data: { user } } = await sb.auth.getUser();
  const title = document.getElementById('pf-title').value.trim();
  if (!title) { alert('Title is required.'); return; }
  const payload = {
    title,
    status_code: document.getElementById('pf-status').value,
    assigned_to: _newProjAssignees.length ? _newProjAssignees.map(p => p.id) : null,
    due_date:    document.getElementById('pf-due').value || null,
    notes:       document.getElementById('pf-notes').value.trim() || null,
    created_by:  user?.id || null,
    team_id:     _newProjTeamId || null,
    updated_at:  new Date().toISOString(),
  };
  const { data: newProj, error } = await sb.from('projects').insert(payload).select().single();
  if (error) { alert('Save failed: ' + error.message); return; }
  _newProjPicker    = null;
  _newProjAssignees = [];
  closeModal();
  if (!store.allProjects) store.allProjects = [];
  store.allProjects.unshift(newProj);
  renderProjects();
  updateProjectStats();
  renderDashProjects();
  logActivity({ action: 'created project', entityType: 'project', entityName: newProj.title, contextType: 'project', contextId: newProj.id });
  // Notify Parish Staff team members if project belongs to that team
  if (newProj.team_id) {
    const team = (store.teams || []).find(t => t.id === newProj.team_id);
    if (team?.name?.toLowerCase().includes('parish staff')) {
      const _uids = await getUserIdsForTeam(newProj.team_id);
      notifyUsers(_uids, user?.id, `New Parish Staff project: ${newProj.title}`, 'info', 'projects', newProj.id);
    }
  }
  // Notify assigned personnel
  if (newProj.assigned_to?.length) {
    for (const personnelId of newProj.assigned_to) {
      const assigneeUserId = await getUserIdForPersonnel(personnelId);
      if (assigneeUserId) notifyUsers([assigneeUserId], user?.id, `You've been assigned to project: ${newProj.title}`, 'info', 'projects', newProj.id);
    }
  }
}

// ── Legacy modal support (used by openModal('project') in main.js) ─────────

export function projectForm(defaultStatus, data) {
  const sc = data?.status_code || defaultStatus || 'not_started';
  const teams = store.teams || [];
  const people = [...(store.personnel || [])].sort((a, b) =>
    (a.name || '').split(' ').pop().localeCompare((b.name || '').split(' ').pop())
  );
  const teamOpts = `<option value="">— None —</option>` +
    teams.map(t => `<option value="${t.id}"${t.id === data?.team_id ? ' selected' : ''}>${t.name}</option>`).join('');
  const peopleOpts = `<option value="">— None —</option>` +
    people.map(p => `<option value="${p.id}"${p.id === data?.assigned_to ? ' selected' : ''}>${p.name}</option>`).join('');
  return `<div class="modal-title">${data ? 'Edit project' : 'Add project'}</div>
  <label>Title</label><input id="f-title" value="${data?.title || ''}" placeholder="Project name" />
  <label>Status</label>
  <select id="f-sc">
    ${Object.entries(STATUS).map(([k, v]) => `<option value="${k}"${k === sc ? ' selected' : ''}>${v.label}</option>`).join('')}
  </select>
  <label>Team (optional)</label>
  <select id="f-team">${teamOpts}</select>
  <label>Assigned to (optional)</label>
  <select id="f-assigned">${peopleOpts}</select>
  <label>Due date</label><input type="date" id="f-due" value="${data?.due_date || ''}" />
  <label>Visibility</label>
  <select id="f-vis">
    <option value="team"${(data?.visibility || 'team') === 'team' ? ' selected' : ''}>Team</option>
    <option value="personal"${data?.visibility === 'personal' ? ' selected' : ''}>Personal</option>
  </select>
  <label>Notes</label><textarea id="f-notes" rows="3">${data?.notes || ''}</textarea>
  <div class="modal-actions" style="justify-content:space-between;">
    ${data ? `<button class="btn-delete" onclick="deleteProject('${data.id}')">Delete</button>` : '<span></span>'}
    <div style="display:flex;gap:8px;">
      <button class="btn-secondary" onclick="closeModal()">Cancel</button>
      <button class="btn-primary" onclick="saveProject(${data ? `'${data.id}'` : null})">Save</button>
    </div>
  </div>`;
}

async function saveProject(id) {
  const title = document.getElementById('f-title').value.trim();
  if (!title) { alert('Title is required.'); return; }
  const payload = {
    title,
    status_code: document.getElementById('f-sc').value,
    team_id:     document.getElementById('f-team').value     || null,
    assigned_to: document.getElementById('f-assigned').value || null,
    due_date:    document.getElementById('f-due').value      || null,
    visibility:  document.getElementById('f-vis').value,
    notes:       document.getElementById('f-notes').value.trim() || null,
    updated_at:  new Date().toISOString(),
  };
  let err;
  if (id) {
    const r = await sb.from('projects').update(payload).eq('id', id); err = r.error;
  } else {
    const r = await sb.from('projects').insert(payload); err = r.error;
  }
  if (err) { alert('Save failed: ' + err.message); return; }
  const { data: { user: _me } } = await sb.auth.getUser();
  logActivity({ action: id ? 'updated project' : 'created project', entityType: 'project', entityName: payload.title, contextType: 'project', contextId: id || null });
  if (!id) {
    // New project via legacy modal
    if (payload.team_id) {
      const team = (store.teams || []).find(t => t.id === payload.team_id);
      if (team?.name?.toLowerCase().includes('parish staff')) {
        const _uids = await getUserIdsForTeam(payload.team_id);
        notifyUsers(_uids, _me?.id, `New Parish Staff project: ${payload.title}`, 'info', 'projects');
      }
    }
    if (payload.assigned_to) {
      const assigneeUserId = await getUserIdForPersonnel(payload.assigned_to);
      if (assigneeUserId) notifyUsers([assigneeUserId], _me?.id, `You've been assigned to project: ${payload.title}`, 'info', 'projects');
    }
  } else {
    // Edit — notify if newly marked complete
    const prior = store.allProjects?.find(p => p.id === id);
    if (payload.status_code === 'complete' && prior?.status_code !== 'complete') {
      const assignees = Array.isArray(prior?.assigned_to) ? prior.assigned_to : (prior?.assigned_to ? [prior.assigned_to] : []);
      for (const personnelId of assignees) {
        const uid = await getUserIdForPersonnel(personnelId);
        if (uid) notifyUsers([uid], _me?.id, `Project marked complete: ${payload.title}`, 'success', 'projects', id);
      }
    }
  }
  closeModal();
  await invalidateProjects();
  loadProjects();
}

async function deleteProject(id) {
  const p = store.allProjects.find(x => x.id === id);
  if (!confirm(`Delete "${p?.title}"? This cannot be undone.`)) return;
  const { error } = await sb.from('projects').delete().eq('id', id);
  if (error) { alert('Delete failed: ' + error.message); return; }
  logActivity({ action: 'deleted project', entityType: 'project', entityName: p?.title || 'Unknown' });
  closeModal();
  await invalidateProjects();
  loadProjects();
}

function openProjectDetail(id) {
  const proj = store.allProjects.find(p => p.id === id);
  if (!proj) return;
  document.getElementById('modal-content').innerHTML = projectForm(proj.status_code, proj);
  document.getElementById('modal-overlay').classList.add('open');
}

function setProjectFilter(f) {
  renderProjects();
}

Object.assign(window, {
  saveProject, deleteProject, openProjectDetail, setProjectFilter,
  renderProjects, saveNewProject, openNewProjectModal,
});
